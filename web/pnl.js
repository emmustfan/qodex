const pnlStages = [
  ['revenue','Выручка'],
  ['direct','Прямые затраты'],
  ['project','Прочие расходы проектов'],
  ['office','Офис']
];
let pnlMode = 'structure';
let pnlDraft = null;
let pnlBreakdown = [];
let pnlSaving = false;
let pnlBlockCounter = 0;

function stageAccepts(stage, scope, amount) {
  if (scope === 'office') return stage === 'office';
  if (amount > 0) return stage === 'revenue';
  return stage === 'direct' || stage === 'project';
}

function structuredPnl(plan,fact) {
  const {blocks,assignments} = data.pnlTemplate;
  const byId = new Map(blocks.map(block => [block.id,block]));
  const routes = {
    office:new Map(assignments.filter(row => row.scope === 'office').map(row => [row.article,row.block])),
    project:new Map(assignments.filter(row => row.scope === 'project').map(row => [row.article,row.block]))
  };
  const group = rows => Map.groupBy(rows,row => {
    const scope = row.project === 'Офис' ? 'office' : 'project';
    const id = routes[scope].get(row.article);
    return stageAccepts(byId.get(id)?.stage,scope,row.amount) ? id : null;
  });
  const planned = group(plan);
  const actual = group(fact);
  pnlBreakdown = [];
  const linkedValue = (label,kind,value,entries,className = '') => {
    if (!entries.length) return rub(value);
    const index = pnlBreakdown.push({label,kind,entries}) - 1;
    return `<button class="pnl-value ${className}" type="button" data-action="pnl-detail:${index}" aria-label="${esc(label + ' · ' + kind + ' · ' + rub(value))}">${rub(value)}</button>`;
  };
  const line = (label,planRows,factRows,className = '') => {
    const expected = totals(planRows).net;
    const result = totals(factRows).net;
    return `<tr class="${className}"><td>${esc(label)}</td>
      <td>${linkedValue(label,'План',expected,planRows.map(row => ({row,kind:'План'})))}</td>
      <td>${linkedValue(label,'Факт',result,factRows.map(row => ({row,kind:'Факт'})))}</td>
      <td class="${sign(result-expected)}">${linkedValue(label,'Отклонение',result-expected,[
        ...planRows.map(row => ({row,kind:'План'})),...factRows.map(row => ({row,kind:'Факт'}))
      ],sign(result-expected))}</td></tr>`;
  };
  const wanted = (index,buckets) => blocks.filter(block => pnlStages.findIndex(([name]) => name === block.stage) <= index)
    .flatMap(block => buckets.get(block.id) || []);
  const rows = [];
  let margin = null;
  for (const [index,[stage]] of pnlStages.entries()) {
    for (const block of blocks.filter(item => item.stage === stage)) {
      rows.push(line(block.name,planned.get(block.id) || [],actual.get(block.id) || []));
    }
    if (stage === 'direct') {
      const planGross = wanted(index,planned);
      const actualGross = wanted(index,actual);
      const fraction = (gross,buckets) => {
        const revenue = totals(wanted(0,buckets)).net;
        return revenue ? totals(gross).net / revenue * 100 : null;
      };
      const plannedMargin = fraction(planGross,planned);
      margin = fraction(actualGross,actual);
      const delta = margin === null || plannedMargin === null ? null : margin - plannedMargin;
      rows.push(line('Маржа проектов',planGross,actualGross,'summary-row'));
      rows.push(`<tr class="pnl-ratio"><td>Маржинальность</td><td>${pnlPercent(plannedMargin)}</td><td>${pnlPercent(margin)}</td>
        <td class="${sign(delta)}">${pnlPercent(delta,' п. п.')}</td></tr>`);
    }
    if (stage === 'project') {
      rows.push(line('Результат проектов до офиса',wanted(index,planned),wanted(index,actual),'summary-row'));
    }
  }
  const missingPlan = planned.get(null) || [];
  const missingFact = actual.get(null) || [];
  if (missingPlan.length || missingFact.length) {
    rows.push(line('Статьи без блока',missingPlan,missingFact,'pnl-unmapped'));
  }
  rows.push(line('Операционный результат',plan,fact,'summary-row'));
  const status = missingPlan.length || missingFact.length
    ? '<small>Статьи без блока включены в операционный результат</small>' : '';
  return {margin,html:table('Структура P&L',['Блок','План','Факт','Отклонение'],rows,'',status)};
}

function pnlPercent(value,unit = '%') {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value) + unit;
}

function pnlDetail(index) {
  const {label,kind,entries} = pnlBreakdown[index];
  const rows = entries.map(({row,kind}) =>
    `<tr><td>${kind}</td><td>${esc(entityName(row.entity))}<small>${esc(row.project)}</small></td>
      <td>${esc(row.article)}</td><td class="wrap">${esc(row.description || 'Строка плана')}
      ${row.day ? `<small>Платёж ${esc(row.day)}</small>` : ''}</td><td class="${sign(row.amount)}">${rub(row.amount)}</td></tr>`);
  const form = modal('Расшифровка',
    table(esc(label + ' · ' + kind),['Вид','ООО и проект','Статья','Источник','Сумма'],rows),() => {});
  form.querySelector('[type=submit]').hidden = true;
}

function pnlEditor() {
  const blocks = pnlDraft.blocks;
  const groupMarkup = pnlStages.map(([stage,label]) => {
    const group = blocks.filter(block => block.stage === stage);
    const rows = group.map((block,index) =>
      `<div class="pnl-edit-row">
        <label><span class="sr-only">Название блока</span>
        <input data-block-name="${block.id}" value="${esc(block.name)}" maxlength="80"></label>
        <div class="actions">
          ${index ? pnlOrderButton('↑','pnl-up:' + block.id,'Вверх') : ''}
          ${index < group.length-1 ? pnlOrderButton('↓','pnl-down:' + block.id,'Вниз') : ''}
          ${pnlOrderButton('×','pnl-remove:' + block.id,'Удалить блок')}
        </div>
      </div>`).join('');
    return `<section class="card"><div class="row"><h2>${label}</h2>${button('+ Блок','pnl-add:' + stage)}</div>
      ${rows || '<small>Блоков пока нет</small>'}</section>`;
  }).join('');
  const routing = new Map(pnlDraft.assignments.map(row => [row.scope + ':' + row.article,row.block]));
  const scopeSelect = (name,scope,amount) => {
    const choices = blocks.filter(block => stageAccepts(block.stage,scope,amount)).map(block => [block.id,block.name]);
    const label = (scope === 'office' ? 'В офисе · ' : 'В проектах · ') + name;
    return `<select aria-label="${esc(label)}" data-pnl-article="${esc(name)}" data-pnl-scope="${scope}">
      ${idOptions([['','Без блока'],...choices],routing.get(scope + ':' + name) || '')}</select>`;
  };
  const articleRows = [...articlesFor('income',true,true).map(name => [name,1]),
    ...articlesFor('expense',true,true).map(name => [name,-1])].sort(([a],[b]) => a.localeCompare(b,'ru')).map(([name,direction]) =>
    `<tr><td>${esc(name)}<small>${direction > 0 ? 'Доход' : 'Расход'}</small></td>
      <td>${scopeSelect(name,'project',direction)}</td><td>${scopeSelect(name,'office',direction)}</td></tr>`);
  return header('Шаблон P&L','Общая структура для проектов, ООО и группы',
    button('Вернуться в БДР','pnl-back') + button('Сохранить шаблон','pnl-save',true))
    + `<div id="pnl-editor">
      <p class="error" id="pnl-edit-error" role="alert"></p>
      <div class="pnl-stage-grid">${groupMarkup}</div>
      <div class="calendar-gap"></div>
      ${table('Куда входят статьи',['Статья БДР','В проектах','В офисе'],articleRows,'',button('Загрузить сохранённый','pnl-reload'))}
    </div>`;
}

function pnlOrderButton(label,action,title) {
  return `<button type="button" class="button" data-action="${action}" aria-label="${title}">${label}</button>`;
}

async function savePnlTemplate(reload) {
  if (pnlSaving) return;
  pnlSaving = true;
  const controls = [...content.querySelectorAll('input, select, button')];
  controls.forEach(control => {control.disabled = true;});
  try {
    if (!reload) await api('pnl-template',pnlDraft);
    data = await api('state');
    pnlDraft = reload ? structuredClone(data.pnlTemplate) : null;
    if (!reload) {
      if (view === 'pnl-template') view = 'profit';
      pnlMode = 'structure';
      notify('Шаблон сохранён.');
    }
    render();
  } catch (error) {
    const message = document.querySelector('#pnl-edit-error');
    if (message) message.textContent = error.message;
  } finally {
    pnlSaving = false;
    controls.forEach(control => {control.disabled = false;});
  }
}

function handlePnlAction(kind,arg) {
  if (!kind.startsWith('pnl-')) return false;
  if (kind === 'pnl-edit') {
    pnlDraft ??= structuredClone(data.pnlTemplate);
    view = 'pnl-template';
    render();
  } else if (kind === 'pnl-back' || kind === 'pnl-mode') {
    if (kind === 'pnl-mode') pnlMode = arg;
    view = 'profit';
    render();
  } else if (kind === 'pnl-detail') {
    pnlDetail(Number(arg));
  } else if (kind === 'pnl-save' || kind === 'pnl-reload') {
    savePnlTemplate(kind === 'pnl-reload');
  } else {
    const blocks = pnlDraft.blocks;
    if (kind === 'pnl-add') {
      if (blocks.length >= 60) {
        notify('В шаблоне может быть до 60 блоков.');
        return true;
      }
      let number = blocks.length + 1;
      while (blocks.some(block => block.name.toLowerCase() === ('новый блок ' + number))) number++;
      const id = 'block-' + Date.now() + '-' + ++pnlBlockCounter;
      blocks.push({id,stage:arg,name:'Новый блок ' + number});
      render();
      document.querySelector(`[data-block-name="${id}"]`).focus();
      return true;
    }
    const index = blocks.findIndex(block => block.id === arg);
    const block = blocks[index];
    if (!block) return true;
    if (kind === 'pnl-remove') {
      blocks.splice(index,1);
      pnlDraft.assignments = pnlDraft.assignments.filter(row => row.block !== arg);
    } else {
      const group = blocks.map((entry,i) => [entry,i]).filter(([entry]) => entry.stage === block.stage).map(([,i]) => i);
      const neighbor = group[group.indexOf(index) + (kind === 'pnl-up' ? -1 : 1)];
      if (neighbor !== undefined) [blocks[index],blocks[neighbor]] = [blocks[neighbor],blocks[index]];
    }
    render();
  }
  return true;
}

document.addEventListener('input',event => {
  const id = event.target.dataset.blockName;
  if (!id) return;
  const block = pnlDraft.blocks.find(item => item.id === id);
  block.name = event.target.value;
  for (const option of document.querySelectorAll(`#pnl-editor option[value="${id}"]`)) {
    option.textContent = block.name || 'Без названия';
  }
});

document.addEventListener('change',event => {
  const {pnlArticle:article,pnlScope:scope} = event.target.dataset;
  if (!article || !scope) return;
  pnlDraft.assignments = pnlDraft.assignments.filter(row => row.article !== article || row.scope !== scope);
  if (event.target.value) pnlDraft.assignments.push({article,scope,block:event.target.value});
});
