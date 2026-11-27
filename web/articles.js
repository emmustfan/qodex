const articleSections = [
  ['revenue','Доходы проектов'],
  ['variable','Переменные затраты проектов'],
  ['direct','Прямые расходы проектов'],
  ['project','Прочие расходы проектов'],
  ['office','Офис до маржинальной прибыли'],
  ['after','Расходы после маржинальной прибыли']
];
const openArticleFolders = new Set();
let articleSectionsOpen = false;
let reportArticleGroup = '';

function articleGroupsById() {
  return new Map(data.articleGroups.map(group => [group.id,group]));
}

function articleGroupChoices() {
  const children = Map.groupBy(data.articleGroups,group => group.parent);
  const visit = (parent,path) => [...(children.get(parent) || [])].sort((a,b) => a.name.localeCompare(b.name,'ru')).flatMap(group => {
    const name = [...path,group.name];
    return [[group.id,name.join(' / ')],...visit(group.id,name)];
  });
  return visit(null,[]);
}

function inArticleGroup(group, parent, groups) {
  for (let id = group; id; id = groups.get(id)?.parent) if (id === parent) return true;
  return false;
}

function reportGroupFilter() {
  if (reportArticleGroup && reportArticleGroup !== 'none' && !data.articleGroups.some(group => group.id === Number(reportArticleGroup))) {
    reportArticleGroup = '';
  }
  return `<select id="reportArticleGroup" aria-label="Группа статей">
    ${idOptions([['','Все группы статей'],...articleGroupChoices(),['none','Статьи без группы']],reportArticleGroup)}</select>`;
}

function filterArticleGroups(rows) {
  if (!reportArticleGroup) return rows;
  const groups = articleGroupsById();
  return rows.filter(row => {
    const group = data.articleMeta[row.article]?.group;
    return reportArticleGroup === 'none' ? !group : inArticleGroup(group,Number(reportArticleGroup),groups);
  });
}

function useArticleProject(article, target) {
  const preferred = data.articleMeta?.[article]?.project;
  if (!target.value && preferred && !data.archivedProjects.includes(preferred)
      && [...target.options].some(option => option.value === preferred)) target.value = preferred;
}

function articleDirectory() {
  const children = Map.groupBy(data.articleGroups,group => group.parent);
  const articles = Map.groupBy([...data.articles].sort((a,b) => a.localeCompare(b,'ru')),name => data.articleMeta[name]?.group || null);
  const directions = {income:'Доход',expense:'Расход',both:'Оба направления'};
  const blocks = new Map(data.pnlTemplate.blocks.map(block => [block.id,block.name]));
  const routes = Map.groupBy(data.pnlTemplate.assignments,row => row.article);
  const article = name => {
    const index = data.articles.indexOf(name);
    const meta = data.articleMeta[name] || {};
    const badges = [data.cashStages.includes(name) ? 'Этап оплаты в БДДС' : directions[data.articleDirections[name]],meta.project,
      ...(routes.get(name) || []).map(entry => blocks.get(entry.block)),
      data.archivedArticles.includes(name) ? 'В архиве' : ''].filter(Boolean);
    return `<li class="article-leaf"><div><strong>${esc(name)}</strong><small>${esc([...new Set(badges)].join(' · '))}</small></div>
      <div class="actions">${button('Настроить','article-config:' + index)} ${directoryControls('articles',name,index)}</div></li>`;
  };
  const folders = parent => [...(children.get(parent) || [])].sort((a,b) => a.name.localeCompare(b.name,'ru')).map(group =>
    `<li><details class="article-folder" data-folder="${group.id}" ${openArticleFolders.has(group.id) ? 'open' : ''}>
      <summary>${esc(group.name)}</summary>
      <div class="actions article-folder-actions">
        ${button('+ Подгруппа','article-group-add:' + group.id)} ${button('+ Статья','article-add:' + group.id)}
        ${button('Настроить группу','article-group-edit:' + group.id)}
        ${!children.has(group.id) && !articles.has(group.id) ? button('Удалить группу','article-group-remove:' + group.id) : ''}
      </div>
      <ul>${folders(group.id)}${(articles.get(group.id) || []).map(article).join('')}</ul>
    </details></li>`).join('');
  const blockRows = articleSections.flatMap(([stage,label]) => {
    const entries = data.pnlTemplate.blocks.filter(block => block.stage === stage);
    return entries.map((block,index) => `<tr><td>${esc(label)}</td><td>${esc(block.name)}</td>
      <td><div class="actions">
        ${index ? articleOrderButton('↑','article-block-up:' + block.id,'Выше') : ''}
        ${index+1 < entries.length ? articleOrderButton('↓','article-block-down:' + block.id,'Ниже') : ''}
        ${button('Изменить','article-block-edit:' + block.id)} ${button('Удалить','article-block-remove:' + block.id)}
      </div></td></tr>`);
  });
  return `<section id="articleDirectory" class="card article-directory">
    <div class="card-head"><h2>Дерево статей</h2><div class="actions">${button('+ Группа','article-group-add')}
      ${button('+ Статья','article',true)}</div></div>
    <ul class="directory-tree">${folders(null)}
      ${articles.has(null) ? `<li><details class="article-folder" data-folder="0" ${openArticleFolders.has(0) ? 'open' : ''}>
        <summary>Без группы</summary><ul>${articles.get(null).map(article).join('')}</ul></details></li>` : ''}
    </ul>
    <details class="article-sections" ${articleSectionsOpen ? 'open' : ''}><summary>Разделы БДР</summary>
      ${table('Строки дерева БДР',['Уровень отчёта','Раздел',''],blockRows,'Добавьте раздел для статей.',button('+ Раздел','article-block-edit',true))}
    </details></section>`;
}

function articleOrderButton(label,action,description) {
  return `<button type="button" class="button" data-action="${action}" aria-label="${description}">${label}</button>`;
}

function articleEditor(name,group) {
  const meta = name ? data.articleMeta[name] || {} : {};
  const revision = data.pnlTemplate.revision;
  const direction = name ? data.articleDirections[name] : 'expense';
  const linked = name ? data.pnlTemplate.assignments.filter(item => item.article === name) : [];
  const isCashOnly = data.cashStages.includes(name) || nonOperating.includes(name);
  const core = name ? `<p class="subtitle">${esc(name)}</p>`
    : field('Название статьи','name','text','','maxlength="100" required')
      + selectField('Направление','direction',[['income','Доход'],['expense','Расход']],direction);
  const form = modal(name ? 'Настроить статью' : 'Новая статья',core + `
    <div class="fields">${selectField('Группа','group',[['','Без группы'],...articleGroupChoices()],meta.group ?? group ?? '',false)}
      ${selectField('Проект по умолчанию','defaultProject',[['','Выбирать при разнесении'],
        ...activeProjects(meta.project ? [meta.project] : []).map(project => [project,project])],meta.project || '',false)}</div>
    ${isCashOnly ? '' : `<div class="fields">${selectField('Раздел БДР в проектах','projectBlock',[],null,false)}
      ${selectField('Раздел БДР в офисе','officeBlock',[],null,false)}</div>`}`,
  values => {
    const destination = values.get('group');
    const groups = articleGroupsById();
    for (let id = Number(destination); id; id = groups.get(id)?.parent) openArticleFolders.add(id);
    if (!destination) openArticleFolders.add(0);
    return api(name ? 'article-classification' : 'article',{...Object.fromEntries(values),article:name,revision});
  });
  if (isCashOnly) return;
  const choices = (scope,direction) => data.pnlTemplate.blocks.filter(block =>
    pnlStageAccepts(block.stage,scope,direction === 'income' ? 1 : -1)).map(block => [block.id,block.name]);
  const update = () => {
    const kind = form.elements.direction?.value || direction;
    for (const scope of ['project','office']) {
      const select = form.elements[scope + 'Block'];
      const saved = linked.find(item => item.scope === scope)?.block;
      const defaultBlock = pnlDefaultBlock(data.pnlTemplate.blocks,scope,kind === 'income' ? 1 : -1);
      select.innerHTML = idOptions([['','По умолчанию · ' + defaultBlock.name],...choices(scope,kind)],select.value || saved || '');
    }
  };
  if (form.elements.direction) form.elements.direction.onchange = update;
  update();
}

function configureArticleGroup(group,parent) {
  const groups = articleGroupsById();
  const choices = articleGroupChoices().filter(([id]) => !group || !inArticleGroup(id,group.id,groups));
  modal(group ? 'Настроить группу' : 'Новая группа',
    field('Название группы','name','text',group?.name || '','maxlength="80" required')
    + selectField('Родительская группа','parent',[['','Верхний уровень'],...choices],group?.parent ?? parent ?? '',false),
  values => {
    const destination = Number(values.get('parent'));
    if (destination) openArticleFolders.add(destination);
    return api('article-group',{...Object.fromEntries(values),id:group?.id});
  });
}

function articleBlockControl(kind,id) {
  const {revision,blocks,assignments} = data.pnlTemplate;
  const block = blocks.find(item => item.id === id);
  const save = (next,routes = assignments) => api('pnl-template',{revision,blocks:next,assignments:routes});
  if (kind === 'article-block-edit') {
    modal(block ? 'Изменить раздел БДР' : 'Новый раздел БДР',field('Название раздела','name','text',block?.name || '','maxlength="80" required')
      + (block ? '' : selectField('Уровень отчёта','stage',articleSections)),
    values => {
      const name = values.get('name');
      return save(block ? blocks.map(item => item.id === id ? {...item,name} : item)
        : [...blocks,{id:'block-' + Date.now(),stage:values.get('stage'),name}]);
    });
  } else if (kind === 'article-block-remove' && block) {
    modal('Удалить раздел БДР',`<p>${esc(block.name)}</p><small>Привязанные статьи перейдут в разделы по умолчанию.</small>`,
      () => save(blocks.filter(item => item.id !== id),assignments.filter(item => item.block !== id)));
  } else if (block) {
    const next = [...blocks];
    const siblings = blocks.map((item,index) => [item,index]).filter(([item]) => item.stage === block.stage).map(([,index]) => index);
    const from = blocks.indexOf(block);
    const to = siblings[siblings.indexOf(from) + (kind === 'article-block-up' ? -1 : 1)];
    if (to === undefined) return;
    [next[from],next[to]] = [next[to],next[from]];
    save(next).then(refreshView).catch(error => notify(error.message));
  }
}

function articleTreeAction(kind,arg) {
  if (kind === 'article-directory') {
    view = 'directories';
    render();
    content.querySelector('#articleDirectory').scrollIntoView();
  } else if (kind === 'article' || kind === 'article-add') articleEditor(null,Number(arg) || null);
  else if (kind === 'article-config') articleEditor(data.articles[Number(arg)]);
  else if (kind === 'article-group-add') configureArticleGroup(null,Number(arg) || null);
  else if (kind === 'article-group-edit') configureArticleGroup(data.articleGroups.find(group => group.id === Number(arg)));
  else if (kind === 'article-group-remove') {
    const group = data.articleGroups.find(item => item.id === Number(arg));
    modal('Удалить группу статей',`<p>${esc(group.name)}</p>`,() => api('article-group-delete',{id:group.id}));
  } else if (kind.startsWith('article-block-')) articleBlockControl(kind,arg);
  else return false;
  return true;
}

document.addEventListener('toggle',event => {
  const item = event.target;
  if (item.matches('.article-sections')) articleSectionsOpen = item.open;
  if (!item.matches('.article-folder')) return;
  const id = Number(item.dataset.folder);
  if (item.open) openArticleFolders.add(id);
  else openArticleFolders.delete(id);
},true);
