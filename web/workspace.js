const roleNames = {employee:'Сотрудник',manager:'Руководитель проекта',finance:'Финансовый директор',owner:'Владелец'};
const activeProjects = (retained = []) => data.projects.filter(name => !data.archivedProjects.includes(name) || retained.includes(name));

function directoryControls(category,name,index) {
  if (name === 'Офис' && category === 'projects' || ['Финансирование','Дивиденды'].includes(name) && category === 'articles') return '—';
  const archived = (category === 'projects' ? data.archivedProjects : data.archivedArticles).includes(name);
  const used = data.directoryUsed[category].includes(name);
  const id = category + '-' + index;
  return (category === 'articles' && !used ? button('Название и вид','directory-edit:' + id) + ' ' : '')
    + (archived ? button('Восстановить','directory-restore:' + id) : button('В архив','directory-archive:' + id))
    + (!used ? ' ' + button('Удалить','directory-delete:' + id) : '');
}

function directoryAction(kind,arg) {
  const [category,index] = arg.split('-');
  const name = data[category][Number(index)];
  const mode = kind.slice('directory-'.length);
  if (mode === 'edit') {
    modal('Изменить статью',field('Название статьи','name','text',name,'maxlength="100" required')
      + selectField('Направление','direction',[['income','Поступления'],['expense','Расходы']],data.articleDirections[name]),
    values => api('article-edit',{current:name,name:values.get('name'),direction:values.get('direction')}));
    return;
  }
  const labels = {archive:'Переместить в архив',restore:'Восстановить',delete:'Удалить'};
  const detail = mode === 'archive' ? 'Запись сохранится в истории и исчезнет из новых форм.'
    : mode === 'delete' ? 'Удаление доступно для записей без финансовых ссылок.' : 'Запись снова будет доступна для новых записей.';
  const form = modal(labels[mode],`<p><strong>${esc(name)}</strong></p><small>${detail}</small>`,
    () => api('directory-change',{category,name,mode}));
  form.querySelector('[type=submit]').textContent = labels[mode];
}

function usersReport() {
  const rows = data.workspaceUsers.map((user,index) =>
    `<tr><td>${esc(user.login)}</td><td>${roleNames[user.role]}</td><td class="wrap">${esc(user.projects.join(', ') || '—')}</td>
      <td><span class="pill ${user.active ? '' : 'pending'}">${user.active ? 'Активен' : 'Доступ удалён'}</span></td>
      <td>${button('Изменить','workspace-user:' + index)}
      ${button(user.active ? 'Удалить доступ' : 'Восстановить доступ',(user.active ? 'workspace-remove:' : 'workspace-restore:') + index)}</td></tr>`);
  return header('Сотрудники','Учётные записи, роли и доступ к проектам',button('+ Сотрудник','workspace-user',true))
    + table('Учётные записи',['Логин','Роль','Проекты руководителя','Доступ',''],rows);
}

function workspaceUser(user) {
  const readonly = user ? 'readonly' : '';
  const loginLabel = data.authProxy ? 'Логин / email из IdP' : 'Логин';
  const choices = activeProjects(user?.projects || []).filter(name => name !== 'Офис');
  const projectFields = choices.map(name =>
    `<label class="finance-option"><input type="checkbox" name="projects" value="${esc(name)}"
      ${user?.projects.includes(name) ? 'checked' : ''}> ${esc(name)}</label>`).join('');
  const password = data.authProxy ? '' : field(user ? 'Новый пароль' : 'Пароль','password','password','',
    'minlength="10" maxlength="250" autocomplete="new-password"' + (user ? '' : ' required'))
    + (user ? '<small>Пустое поле сохраняет прежний пароль.</small>' : '');
  const form = modal(user ? 'Изменить сотрудника' : 'Новый сотрудник',
    field(loginLabel,'login','text',user?.login || '',`maxlength="150" required ${readonly}`)
    + selectField('Роль','role',Object.entries(roleNames),user?.role || 'employee') + password
    + `<div id="workspace-projects" hidden><small>Проекты руководителя</small>${projectFields || '<p>Сначала добавьте проект.</p>'}</div>`,
  values => api('user-save',{login:values.get('login'),role:values.get('role'),password:values.get('password') || '',
    projects:values.getAll('projects')}));
  const update = () => {form.querySelector('#workspace-projects').hidden = form.elements.role.value !== 'manager';};
  form.elements.role.onchange = update;
  update();
}

function projectFinances() {
  const selected = row => inEntity(row.entity) && (!project || row.project === project);
  const {facts,plans,forecast} = data.managerFinances;
  const fact = facts.filter(row => selected(row) && row.month === period);
  const plan = plans.filter(row => selected(row) && row.month === period && row.scenario === scenario);
  const actual = fact.filter(row => row.basis === 'БДР').reduce((s,row) =>
    ({income:s.income+row.income,expense:s.expense+row.expense}),{income:0,expense:0});
  const report = (basis) => {
    const posted = fact.filter(row => row.basis === basis);
    const budget = plan.filter(row => row.basis === basis);
    const labels = [...new Set([...posted,...budget].map(row => row.article))].sort((a,b) => a.localeCompare(b,'ru'));
    const rows = labels.map(article => {
      const p = totals(budget.filter(row => row.article === article)).net;
      const f = totals(posted.filter(row => row.article === article)).net;
      return `<tr><td>${esc(article)}</td><td>${rub(p)}</td><td>${rub(f)}</td><td class="${sign(f-p)}">${rub(f-p)}</td></tr>`;
    });
    return table(basis + ' по проектам',['Статья','План','Факт','Отклонение'],rows);
  };
  const planRows = plan.map(row => `<tr><td>${esc(row.project)}</td><td>${esc(entityName(row.entity))}</td><td>${esc(row.basis)}</td>
    <td>${esc(row.article)}</td><td>${rub(row.amount)}</td>
    <td>${activeProjects().includes(row.project) && !data.archivedArticles.includes(row.article) ? button('Изменить','manager-plan-edit:' + row.id) : ''}
    ${button('Удалить','manager-plan-remove:' + row.id)}</td></tr>`);
  const entries = forecast.filter(row => selected(row) && row.day.startsWith(period));
  const schedules = entries.map(row => ({row,planned:true}));
  const obligations = data.requests.filter(row => selected(row) && row.status === 'Согласована'
    && outstanding(row) && dueDate(row).startsWith(period)).map(item =>
    ({row:{...item,description:item.title,day:dueDate(item),amount:-outstanding(item)},planned:false}));
  const rows = [...schedules,...obligations].sort((a,b) => a.row.day.localeCompare(b.row.day)).map(({row,planned}) =>
    `<tr><td>${esc(row.day)}</td><td>${esc(row.project)}<small>${esc(entityName(row.entity))}</small></td>
      <td class="wrap">${esc(row.description)}<small>${planned ? 'Ожидаемая операция' : 'Остаток по согласованной заявке'}</small></td>
      <td class="${sign(row.amount)}">${rub(row.amount)}</td><td>${planned
        ? (activeProjects().includes(row.project) ? button('Изменить','manager-forecast-edit:' + row.id) : '')
          + ' ' + button('Удалить','manager-forecast-remove:' + row.id)
        : ''}</td></tr>`);
  const actions = activeProjects().length ? button('+ План БДР','manager-plan:БДР')
    + button('+ План БДДС','manager-plan:БДДС') + button('+ Ожидаемая операция','manager-forecast',true) : '';
  return header('Мои проекты','Финансовые результаты и планирование по назначенным проектам',actions)
    + filters(true,false,false) + `<div class="metrics">${card('Доходы БДР',rub(actual.income),'Факт')}
      ${card('Расходы БДР',rub(actual.expense),'Факт')}${card('Результат проектов',rub(actual.income-actual.expense),'Факт по начислениям')}</div>`
    + report('БДР') + '<div class="calendar-gap"></div>' + report('БДДС') + '<div class="calendar-gap"></div>'
    + table('Строки бюджета',['Проект','ООО','Отчёт','Статья','Сумма',''],planRows)
    + '<div class="calendar-gap"></div>' + table('График поступлений и выплат',['Дата','Проект','Назначение','Сумма',''],rows);
}

function projectForecast(entry) {
  const form = modal(entry ? 'Изменить ожидаемую операцию' : 'Ожидаемая операция проекта',
    selectField('ООО','entity',legalOptions(),entry?.entity ?? entity)
    + picker('Проект','project',activeProjects(),entry?.project ?? project)
    + selectField('Движение','direction',[['income','Поступление'],['expense','Выплата']],entry?.amount < 0 ? 'expense' : 'income')
    + field('Дата','day','date',entry?.day || period + '-01','required')
    + field('Назначение','description','text',entry?.description || '','required maxlength="200"')
    + field('Сумма, ₽','amount','number',entry ? Math.abs(entry.amount) / 100 : '','min="0.01" step="0.01" required'),
  values => api('forecast',{...Object.fromEntries(values),id:entry?.id,
    amount:(values.get('direction') === 'expense' ? '-' : '') + values.get('amount')}));
  return form;
}

function workspaceAction(kind,arg) {
  if (kind.startsWith('directory-')) directoryAction(kind,arg);
  else if (kind === 'workspace-user') workspaceUser(arg === undefined ? null : data.workspaceUsers[Number(arg)]);
  else if (kind === 'workspace-remove' || kind === 'workspace-restore') {
    const user = data.workspaceUsers[Number(arg)];
    const remove = kind === 'workspace-remove';
    const title = remove ? 'Удалить доступ' : 'Восстановить доступ';
    const form = modal(title,`<p>${esc(user.login)}</p><small>${remove ? 'Вход будет отключён. Заявки и журнал сохранятся.' : 'Учётная запись снова сможет войти.'}</small>`,
      () => api(remove ? 'user-remove' : 'user-restore',{login:user.login}));
    form.querySelector('[type=submit]').textContent = title;
  } else if (kind === 'manager-plan') budgetEntry('plan',arg);
  else if (kind === 'manager-plan-edit') {
    const row = data.managerFinances.plans.find(item => item.id === Number(arg));
    budgetEntry('plan',row.basis,row);
  } else if (kind === 'manager-forecast' || kind === 'manager-forecast-edit') {
    projectForecast(kind === 'manager-forecast-edit' ? data.managerFinances.forecast.find(item => item.id === Number(arg)) : null);
  } else if (kind === 'manager-plan-remove' || kind === 'manager-forecast-remove') {
    const form = modal('Удалить строку',
      '<p>Строка исчезнет из текущего плана.</p>',
      () => api(kind === 'manager-plan-remove' ? 'remove-plan' : 'remove-forecast',{id:Number(arg)}));
    form.querySelector('[type=submit]').textContent = 'Удалить';
  } else return false;
  return true;
}
