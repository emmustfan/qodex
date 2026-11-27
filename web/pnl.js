let pnlMode = 'structure';
let pnlBreakdown = [];
const treeExpanded = new Map();

function pnlStageAccepts(stage,scope,amount) {
  if (stage === 'after') return amount < 0;
  if (scope === 'office') return stage === 'office';
  if (amount > 0) return stage === 'revenue';
  return stage === 'variable' || stage === 'direct' || stage === 'project';
}

function pnlDefaultBlock(blocks,scope,amount) {
  const stage = scope === 'office' ? 'office' : amount > 0 ? 'revenue' : 'direct';
  return blocks.find(block => block.id === stage && block.stage === stage)
    || blocks.find(block => block.stage === stage)
    || {id:'default-' + stage,stage,name:articleSections.find(([id]) => id === stage)[1]};
}

const reportEntries = (plan,fact) => [
  ...plan.map(row => ({row,kind:'План'})),...fact.map(row => ({row,kind:'Факт'}))
];

function reportAmounts(entries) {
  return entries.reduce((total,entry) => {
    if (entry.kind === 'План') total.plan += entry.row.amount;
    else total.fact += entry.row.amount;
    return total;
  },{plan:0,fact:0});
}

function groupedArticleNodes(entries) {
  const groups = articleGroupsById();
  const root = new Map();
  for (const entry of entries) {
    const folders = [];
    let group = groups.get(data.articleMeta[entry.row.article]?.group);
    while (group) {
      folders.unshift(['group-' + group.id,group.name]);
      group = groups.get(group.parent);
    }
    const path = [...folders,['article-' + entry.row.article,entry.row.article]];
    let level = root;
    for (const [id,label] of path) {
      if (!level.has(id)) level.set(id,{id,label,entries:[],children:new Map()});
      const node = level.get(id);
      node.entries.push(entry);
      level = node.children;
    }
  }
  const unpack = map => [...map.values()].sort((a,b) => a.label.localeCompare(b.label,'ru')).map(node => ({
    ...node,children:unpack(node.children)
  }));
  return unpack(root);
}

function pnlStructure(plan,fact) {
  const entries = reportEntries(plan,fact);
  const {blocks,assignments} = data.pnlTemplate;
  const byId = new Map(blocks.map(block => [block.id,block]));
  const routes = {
    office:new Map(),project:new Map()
  };
  for (const entry of assignments) routes[entry.scope].set(entry.article,entry.block);
  const order = new Map(blocks.map((block,index) => [block.id,index]));
  const stageOrder = new Map(articleSections.map(([stage],index) => [stage,index]));
  const placed = entries.map(entry => {
    const {row} = entry;
    const scope = row.project === 'Офис' ? 'office' : 'project';
    const assigned = byId.get(routes[scope].get(row.article));
    const block = pnlStageAccepts(assigned?.stage,scope,row.amount) ? assigned : pnlDefaultBlock(blocks,scope,row.amount);
    return {...entry,block};
  });
  const after = placed.filter(entry => entry.block.stage === 'after');
  const office = placed.filter(entry => entry.block.stage === 'office');
  const projects = placed.filter(entry => !['office','after'].includes(entry.block.stage));
  const revenue = projects.filter(entry => entry.block.stage === 'revenue');
  const accum = reportAmounts(projects);
  const earned = reportAmounts(revenue);
  const margin = earned.fact ? accum.fact / earned.fact * 100 : null;
  const summary = (id,label,entries,factOnly = false) => ({id,label,entries,factOnly,summary:true});
  const blockNodes = rows => [...Map.groupBy(rows,entry => entry.block.id).values()]
    .sort(([a],[b]) => stageOrder.get(a.block.stage) - stageOrder.get(b.block.stage)
      || (order.get(a.block.id) ?? blocks.length) - (order.get(b.block.id) ?? blocks.length))
    .map(list => ({id:list[0].block.id,label:list[0].block.name,entries:list,children:groupedArticleNodes(list)}));
  const branches = (rows,id,label,children) => rows.length ? [{id,label,entries:rows,children,open:true}] : [];
  const marginCoverage = data.productStructure && period >= productPlanStart;
  const projectEntries = Map.groupBy(projects,entry => entry.row.project);
  if (marginCoverage) {
    const parents = new Set(Object.values(data.projectParents));
    for (const name of activeProjects()) {
      if (name !== 'Офис' && (Object.hasOwn(data.licenseUnits,name) || parents.has(name))
          && projectInScope(name) && !projectEntries.has(name)) projectEntries.set(name,[]);
    }
  }
  const perProject = [...projectEntries.entries()]
    .sort(([a],[b]) => (a || '').localeCompare(b || '','ru'));
  const roots = new Map();
  for (const [name,rows] of perProject) {
    const path = projectAncestors(name).reverse();
    const visiblePath = project && path.includes(project) ? path.slice(path.indexOf(project)) : path;
    let level = roots;
    for (const segment of visiblePath) {
      if (!level.has(segment)) level.set(segment,{name:segment,own:[],entries:[],children:new Map()});
      const node = level.get(segment);
      node.entries.push(...rows);
      if (segment === name) node.own = rows;
      level = node.children;
    }
  }
  const coverage = rows => rows.filter(entry => ['revenue','variable'].includes(entry.block.stage));
  const component = (rows,id,label) => rows.length ? branches(rows,id,label,blockNodes(rows))
    : marginCoverage ? [{id,label,entries:[]}] : [];
  const components = rows => {
    const income = rows.filter(entry => entry.block.stage === 'revenue');
    const variable = rows.filter(entry => entry.block.stage === 'variable');
    const fixed = rows.filter(entry => !['revenue','variable'].includes(entry.block.stage));
    return [
      ...component(income,'income','Доходы'),
      ...component(variable,'variable','Переменные расходы'),
      ...(marginCoverage || variable.length ? [summary('coverage','Маржа покрытия',coverage(rows))] : []),
      ...component(fixed,'expense','Остальные расходы продукта')
    ];
  };
  const productNode = node => ({id:'project-' + node.name,label:node.name || 'Без проекта',entries:node.entries,open:true,project:true,children:[
    ...(node.children.size ? [
      ...branches(node.own,'shared','Общее по продукту',components(node.own)),...Array.from(node.children.values(),productNode),
      ...(marginCoverage || node.entries.some(entry => entry.block.stage === 'variable')
        ? [summary('coverage','Маржа покрытия продукта',coverage(node.entries))] : [])
    ] : components(node.own)),
    summary('adjusted','Скорректированный доход',node.entries)
  ]});
  const nodes = Array.from(roots.values(),productNode);
  if (roots.size > 1) nodes.push(summary('all-projects','Скорректированный доход проектов',projects));
  if (!project || project === 'Офис') nodes.push(...component(office,'office','Офис'));
  if (!project && (projects.length || office.length || after.length || marginCoverage)) {
    nodes.push(summary('operating-margin',data.productStructure ? 'Результат после офиса' : 'Маржинальная прибыль',[...projects,...office]));
  }
  const afterBlocks = blockNodes(after).map(node => ({
    ...node,
    children:[...Map.groupBy(node.entries,entry => entry.row.project).entries()].map(([name,rows]) => ({
      id:'after-' + name,label:name || 'Без проекта',entries:rows,children:groupedArticleNodes(rows)
    }))
  }));
  nodes.push(...branches(after,'after','Расходы после маржинальной прибыли',afterBlocks));
  if (entries.length || nodes.length) nodes.push(summary('result','Операционный результат',entries));
  if (!project) {
    const dividends = data.profit_decisions.filter(row => inEntity(row.entity) && row.month === period && !row.canceled && !row.fund)
      .map(row => ({kind:'Факт',row:{...row,article:'Дивиденды',description:row.note,amount:-row.amount}}));
    if (dividends.length) {
      nodes.push(summary('dividends','Решения о дивидендах',dividends,true));
      nodes.push(summary('after-dividends','Остаток после решений о дивидендах',[...entries,...dividends],true));
    }
  }
  return {nodes,margin,adjusted:accum.fact};
}

function financialTree(title,nodes,kind,mode = 'totals') {
  pnlBreakdown = [];
  const linked = (label,kind,value,entries) => {
    if (value === null) return '—';
    if (!entries.length) return rub(value);
    const index = pnlBreakdown.push({label,kind,entries}) - 1;
    return `<button class="pnl-value" type="button" data-action="pnl-detail:${index}" aria-label="${esc(label + ' · ' + kind + ' · ' + rub(value))}">${rub(value)}</button>`;
  };
  let index = 0;
  const markup = (items,depth,parent,path,hidden) => items.flatMap(node => {
    const id = ++index;
    const key = JSON.stringify([...path,node.id]);
    const children = node.children || [];
    const expandable = children.length > 0;
    const open = treeExpanded.get(key) ?? node.open ?? false;
    const {plan,fact} = reportAmounts(node.entries);
    const planRows = node.entries.filter(entry => entry.kind === 'План');
    const factRows = node.entries.filter(entry => entry.kind === 'Факт');
    const delta = fact - plan;
    const label = expandable
      ? `<button type="button" class="tree-toggle" data-action="pnl-toggle:${id}" aria-expanded="${open}" aria-label="${esc(node.label)}">${esc(node.label)}</button>`
      : esc(node.label);
    const values = (mode === 'fact' ? '' : `<td>${linked(node.label,'План',node.factOnly ? null : plan,planRows)}</td>`)
      + `<td>${linked(node.label,'Факт',fact,factRows)}</td>`
      + (mode === 'fact' ? '' : `<td class="${sign(node.factOnly ? 0 : delta)}">${linked(node.label,'Отклонение',node.factOnly ? null : delta,node.entries)}</td>`);
    const rowClass = node.summary ? 'summary-row' : node.project ? 'tree-project' : expandable ? 'tree-branch' : '';
    return [`<tr class="${rowClass}" data-tree-id="${id}" data-tree-parent="${parent}" data-tree-key="${esc(key)}" data-tree-depth="${depth}" ${hidden ? 'hidden' : ''}>
      <td style="--tree-depth:${depth}">${label}</td>${values}</tr>`,...markup(children,depth+1,id,[...path,node.id],hidden || !open)];
  });
  return `<div class="financial-tree">${table(title,mode === 'fact' ? ['Статья или группа','Факт'] : ['Строка отчёта','План','Факт','Отклонение'],
    markup(nodes,0,0,[kind],false),'За выбранный период записей нет.')}</div>`;
}

function toggleFinanceTree(id) {
  const rows = [...content.querySelectorAll('[data-tree-id]')];
  const target = rows.find(row => Number(row.dataset.treeId) === id);
  const control = target.querySelector('.tree-toggle');
  const open = control.getAttribute('aria-expanded') !== 'true';
  control.setAttribute('aria-expanded',String(open));
  treeExpanded.set(target.dataset.treeKey,open);
  const visible = new Map([[0,true]]);
  for (const row of rows) {
    row.hidden = !visible.get(Number(row.dataset.treeParent));
    const toggle = row.querySelector('.tree-toggle');
    visible.set(Number(row.dataset.treeId),!row.hidden && toggle?.getAttribute('aria-expanded') === 'true');
  }
}

function pnlPercent(value) {
  return value === null ? '—' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value) + '%';
}

function pnlDetail(index) {
  const {label,kind,entries} = pnlBreakdown[index];
  const rows = entries.map(({row,kind}) =>
    `<tr><td>${kind}</td><td>${esc(entityName(row.entity))}<small>${esc(row.project)}</small></td>
      <td>${esc(row.article)}</td><td class="wrap">${esc(row.description || (kind === 'План' ? 'Строка плана' : 'Начисление'))}
      ${row.day ? `<small>${esc(row.day)}</small>` : ''}</td><td class="${sign(row.amount)}">${rub(row.amount)}</td></tr>`);
  const form = modal('Расшифровка',
    table(esc(label + ' · ' + kind),['Вид','ООО и проект','Статья','Источник','Сумма'],rows),() => {});
  form.querySelector('[type=submit]').parentElement.hidden = true;
}

function handlePnlAction(kind,arg) {
  if (kind === 'pnl-mode') {
    pnlMode = arg;
    render();
  } else if (kind === 'pnl-toggle') toggleFinanceTree(Number(arg));
  else if (kind === 'pnl-detail') pnlDetail(Number(arg));
  else return false;
  return true;
}
