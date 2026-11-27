let reviewDate = '';
let monthReview = null;

function workingMonthScope() {
  const start = period + '-01';
  const end = new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);
  const today = new Date().toLocaleDateString('sv-SE');
  const day = reviewDate.startsWith(period) ? reviewDate : [start,today,end].sort()[1];
  return {entity:Number(entity),month:period,scenario,day,start,end};
}

const monthMoney = amount => amount === null ? '—' : rub(amount);
const reviewProject = row => projectInScope(row.project);
const monthDateLabel = day => new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(day));

function workingMonth() {
  const scope = workingMonthScope();
  const weeks = [];
  for (let next = new Date(scope.start); next.toISOString().slice(0,10) <= scope.end; next.setUTCDate(next.getUTCDate()+1)) {
    const day = next.toISOString().slice(0,10);
    if (next.getUTCDay() === 0 || day === scope.end) {
      weeks.push(`<button class="button" data-action="month-date:${day}" aria-pressed="${day === scope.day}">
        ${monthDateLabel(day)}</button>`);
    }
  }
  const closed = data.periodClosures.some(row => row.entity === scope.entity && row.month === scope.month);
  return header('Рабочий месяц','Деньги, бюджет и решения по проектам',
    button('Банковские операции','view:operations') + button(closed ? 'Месяц закрыт' : 'Проверить и закрыть',
      closed ? 'view:periods' : 'period-close:' + scope.entity, !closed))
    + `<div class="toolbar">${filterField('Период',`<input type="month" id="period" aria-label="Отчётный месяц" value="${scope.month}">`)}
      ${filterField('ООО',`<select id="entity" aria-label="Юридическое лицо">${idOptions(legalOptions(),entity)}</select>`)}
      ${filterField('Проект',`<select id="project" aria-label="Проект"><option value="">Все проекты</option>${options(data.projects,project)}</select>`)}
      ${filterField('Сценарий',`<select id="scenario" aria-label="Сценарий бюджета">${options(data.scenarios,scenario)}</select>`)}</div>`
    + `<div class="month-cutoff"><label for="workingDate">Дата денежного среза</label>
        <input id="workingDate" type="date" value="${scope.day}" min="${scope.start}" max="${scope.end}">
        <div class="actions" role="group" aria-label="Концы недель">${weeks.join('')}</div></div>
      <nav class="month-links" aria-label="Рабочий месяц">
        <a href="#month-cash">Деньги</a><a href="#month-pnl">План и факт</a>
        <a href="#month-rules">Правила и премии</a><a href="#month-actions">Действия</a>
      </nav>
      <div id="monthDesk" class="month-stack" aria-live="polite"></div>`;
}

function loadWorkingMonth() {
  const scope = workingMonthScope();
  const key = JSON.stringify(scope);
  const show = () => {
    if (view !== 'month-workspace' || monthReview?.key !== key || monthReview.state !== data) return;
    const desk = content.querySelector('#monthDesk');
    if (monthReview.result) desk.innerHTML = monthDetails(scope,monthReview.result);
    else if (monthReview.error) desk.innerHTML = `<p class="error">${esc(monthReview.error)}</p>` + button('Обновить','release-refresh');
    else desk.innerHTML = '<p class="empty">Загружаем показатели месяца…</p>';
  };
  if (monthReview?.key !== key || monthReview.state !== data) {
    const pending = {key,state:data,scope};
    monthReview = pending;
    api('month-review',scope).then(result => {pending.result = result; show();},
      error => {pending.error = error.message; show();});
  }
  show();
}

function monthLiquidity(scope, bonuses) {
  const company = scope.entity;
  const operations = data.operations.filter(op => op.day <= scope.day);
  const ledgerAccounts = new Set(operations.map(op => op.account));
  const opened = new Set(data.account_balances.map(row => row.account));
  const controlled = new Set(data.statement_controls.filter(row => row.month <= scope.month).map(row => row.account));
  const accounts = data.accounts.filter(row => row.entity === company
    && (row.bank_key || ledgerAccounts.has(row.id) || opened.has(row.id) || controlled.has(row.id)));
  const balance = bankBalanceAt(scope.day,accounts,true);
  const canceled = new Set(data.profit_decisions.filter(row => row.canceled).map(row => row.id));
  const funds = data.funds.filter(row => row.entity === company);
  const entries = Map.groupBy(data.fund_entries.filter(row => !canceled.has(row.decision)),row => row.fund);
  const currentFunds = funds.map(fund => {
    const rows = entries.get(fund.id) || [];
    const reserved = totals(rows.filter(row => row.day <= scope.day)).net;
    const plannedRelease = totals(rows.filter(row => row.day > scope.day && row.day <= scope.end)).outgoing;
    return {...fund,reserved,available:Math.max(0,reserved-plannedRelease)};
  });
  const free = balance === null ? null : balance-currentFunds.reduce((sum,row) => sum+row.reserved,0);
  const paidByDate = new Map(operations.map(row => [row.id,-row.amount]));
  const payments = Map.groupBy(data.request_payments,row => row.request);
  const approved = data.requests.filter(row => row.entity === company && row.status === 'Согласована').map(row => ({
    ...row,remaining:Math.max(0,row.amount-(payments.get(row.id) || [])
      .reduce((sum,payment) => sum+(paidByDate.get(payment.operation) || 0),0))
  }));
  const approvedDue = approved.filter(row => row.remaining && dueDate(row) <= scope.end);
  const manual = data.forecast_entries.filter(row => row.entity === company && row.day <= scope.end);
  const reservedChanges = funds.flatMap(fund => entries.get(fund.id) || [])
    .filter(row => row.day > scope.day && row.day <= scope.end)
    .map(row => ({day:row.day,reserve:-row.amount,amount:0}));
  const bonusDue = bonuses.flatMap(bonus => {
    const covered = approved.filter(row => row.project === bonus.project && row.article === bonus.article && row.day.startsWith(bonus.month))
      .reduce((sum,row) => sum+row.remaining,0);
    const amount = Math.max(0,bonus.amount-bonus.paid-covered);
    return amount ? [{...bonus,day:bonus.month === scope.month ? scope.end : scope.day,amount:-amount}] : [];
  });
  const movements = Map.groupBy([...manual,...approvedDue.map(row => ({day:dueDate(row),amount:-row.remaining})),
    ...bonusDue,...reservedChanges],row => row.day < scope.day ? scope.day : row.day);
  let running = free;
  let minimum = free;
  const days = [...movements].sort(([one],[two]) => one.localeCompare(two)).map(([day,rows]) => {
    const total = totals(rows);
    const reserve = rows.reduce((sum,row) => sum+(row.reserve || 0),0);
    if (free !== null) {
      running += total.net+reserve;
      minimum = Math.min(minimum,running);
    }
    return {day,...total,reserve,running};
  });
  return {balance,free,minimum,end:running,funds:currentFunds,days,manual,approvedDue,bonusDue};
}

function monthCashSection(scope, review, closed) {
  const cash = monthLiquidity(scope,review.bonuses);
  const bankFact = totals(cashRows().filter(row => row.month === scope.month && row.day <= scope.day && reviewProject(row)));
  const cashPlan = data.plans.filter(row => row.basis === 'БДДС' && row.month === scope.month && row.entity === scope.entity
    && row.scenario === scope.scenario && row.amount > 0 && reviewProject(row));
  const receiptTarget = cashPlan.length ? totals(cashPlan).incoming : null;
  const reserved = cash.funds.reduce((sum,row) => sum+row.reserved,0);
  const gap = cash.minimum === null ? null : Math.max(0,-cash.minimum);
  const available = cash.funds.reduce((sum,row) => sum+row.available,0);
  const days = cash.days.map(row => `<tr><td>${esc(row.day)}</td><td>${rub(row.incoming)}</td><td>${rub(row.outgoing)}</td>
    <td>${rub(row.reserve)}</td><td class="${sign(row.running)}">${monthMoney(row.running)}</td></tr>`);
  const funds = cash.funds.map(row => `<tr><td>${esc(row.name)}</td><td>${rub(row.reserved)}</td><td>${rub(row.available)}</td>
    <td>${!closed && row.reserved > 0 ? button('Высвободить','month-fund:' + row.id) : ''}</td></tr>`);
  const receipts = cash.manual.filter(reviewProject).sort((a,b) => a.day.localeCompare(b.day)).map(row => `<tr>
    <td>${esc(row.day)}</td><td class="wrap">${esc(row.description)}<small>${esc(row.project || 'Компания')}</small></td>
    <td class="${sign(row.amount)}">${rub(row.amount)}</td>
    <td>${button('Изменить','month-forecast:' + row.id)} ${button('Отметить исполненной','month-forecast-done:' + row.id)}</td></tr>`);
  const obligations = cash.approvedDue.filter(reviewProject).sort((a,b) => dueDate(a).localeCompare(dueDate(b))).map(row => `<tr>
    <td>${esc(dueDate(row))}</td><td class="wrap">${esc(row.title)}<small>${esc(row.project)}</small></td><td>${rub(row.remaining)}</td>
    <td>${button('Оплаты','payments:' + row.id)} ${button('Перенести','reschedule:' + row.id)}</td></tr>`);
  return `<section class="month-stack" id="month-cash">
    <div class="row"><h2>Деньги · ${esc(entityName(scope.entity))}</h2><div class="actions">
      ${button('+ Ожидаемое движение','month-forecast',true)} ${button('+ Заявка','request')} ${button('Счета и остатки','view:accounts')}</div></div>
    <div class="metrics month-metrics">
      ${card('На счетах на ' + monthDateLabel(scope.day),monthMoney(cash.balance),cash.balance === null ? 'Проверьте остатки и счета операций' : 'По банковским операциям')}
      ${card('Свободно на дату среза',monthMoney(cash.free),'В фондах ' + rub(reserved))}
      ${card('Прогноз свободных денег',monthMoney(cash.end),'На конец месяца')}
      ${card('Кассовый разрыв',monthMoney(gap),gap > 0 && available ? 'Можно высвободить из фондов до ' + rub(Math.min(gap,available)) : 'По минимальному остатку')}
    </div>
    <div class="card month-receipts"><div><small>Пришло с начала месяца${project ? ' · ' + esc(project) : ''}</small><strong>${rub(bankFact.incoming)}</strong>
      ${receiptTarget === null ? '' : `<small>План ${rub(receiptTarget)} · осталось ${rub(Math.max(receiptTarget-bankFact.incoming,0))}</small>`}</div>
      <div><small>Ушло с начала месяца</small><strong>${rub(bankFact.outgoing)}</strong></div>
      <div><small>Выплаты по заявкам ООО</small><strong>${rub(cash.approvedDue.reduce((sum,row) => sum+row.remaining,0))}</strong></div>
      <div><small>Подтверждённые премии вне заявок</small><strong>${rub(totals(cash.bonusDue).outgoing)}</strong></div></div>
    <small>Плановые расходы БДР учитываются в денежном прогнозе через заявки или ожидаемые движения с датой оплаты.</small>
    ${table('Прогноз свободных денег',['Дата','Ожидаем приход','Ожидаем выплату','Изменение за счёт фондов','Свободно'],days,
      'До конца месяца ожидаемых движений нет.')}
    ${table('Фонды ООО',['Фонд','Резерв на дату','Резерв без запланированных высвобождений',''],funds,'У этого ООО пока нет фондов.',button('Открыть фонды','view:funds'))}
    <details class="month-details"><summary>Ожидаемые движения и заявки</summary>
      <small>После отражения ручного прогноза в банке отметьте движение исполненным. Оплаты согласованных заявок уже входят в прогноз.</small>
      ${table('Движения из прогноза',['Дата','Назначение','Сумма',''],receipts,'Ручных движений нет.')}
      ${table('Заявки к оплате',['Срок','Заявка','Осталось',''],obligations,'Неоплаченных заявок до конца месяца нет.')}</details>
    </section>`;
}

function monthPnl(scope, closed) {
  const versions = data.budget_versions.filter(row => row.month === scope.month && row.basis === 'БДР' && row.scenario === scope.scenario);
  const saved = versions.find(row => row.id === Number(version));
  const budgetRows = (saved?.rows || data.plans.filter(row => row.basis === 'БДР' && row.scenario === scope.scenario))
    .filter(row => row.entity === scope.entity && row.month === scope.month && reviewProject(row));
  const facts = filterRows(profitRows());
  const joined = new Map();
  for (const [key,rows] of [['plan',budgetRows],['fact',facts]]) {
    for (const row of rows) {
      const code = JSON.stringify([row.project,row.article]);
      if (!joined.has(code)) joined.set(code,{project:row.project,article:row.article,plan:0,fact:0});
      joined.get(code)[key] += row.amount;
    }
  }
  const values = [...joined.values()].sort((a,b) => a.project.localeCompare(b.project,'ru') || a.article.localeCompare(b.article,'ru'));
  const cols = row => [row.plan,row.fact,row.fact-row.plan].map((amount,i) =>
    `<td class="${i === 2 ? sign(amount) : ''}">${rub(amount)}</td>`).join('');
  const rows = values.map(row => `<tr><td>${esc(row.project)}</td><td>${esc(row.article)}</td>${cols(row)}</tr>`);
  if (rows.length) rows.push(`<tr class="summary-row"><td colspan="2"><strong>Результат</strong></td>
      ${cols({plan:totals(budgetRows).net,fact:totals(facts).net})}</tr>`);
  const editable = !closed && !saved;
  const editRows = budgetRows.map(row => `<tr><td>${esc(row.project)}</td><td>${esc(row.article)}${row.source === 'monthly-rule' ? '<small>По правилу</small>' : ''}</td>
    <td>${rub(row.amount)}</td><td>${button('Изменить','month-plan-edit:' + row.id)} ${button('Удалить','month-plan-remove:' + row.id)}</td></tr>`);
  return `<section class="month-stack" id="month-pnl">
    <div class="row"><div><h2>План и факт БДР</h2><small>Начисления за весь выбранный месяц</small></div>
    <div class="actions"><select id="version" aria-label="Версия плана БДР"><option value="">Текущий план</option>
      ${idOptions(versions.map(row => [row.id,row.name]),version)}</select>
      ${editable ? button('+ Строка плана','plan:БДР',true) + button('Зафиксировать план','freeze-budget:БДР') : ''}
      ${!closed ? button('+ Начисление','accrual') : ''} ${button('Отчёт БДР','view:profit')}</div></div>
    ${table('БДР по проектам и статьям',['Проект','Статья','План','Факт','Отклонение'],rows,'Добавьте план или начисления за месяц.')}
    ${editable && editRows.length ? `<details class="month-details"><summary>Изменить строки текущего плана</summary>
      ${table('Строки бюджета',['Проект','Статья','Сумма',''],editRows)}</details>` : ''}
    </section>`;
}

function monthRules(scope, review, closed) {
  const earlier = review.bonuses.filter(row => row.month < scope.month && reviewProject(row)).map(row => `<tr>
    <td>${esc(row.month)}</td><td>${esc(row.project)} · ${esc(row.article)}</td>
    <td>${rub(row.amount)}</td><td>${rub(row.paid)}</td><td>${rub(Math.max(0,row.amount-row.paid))}</td></tr>`);
  const rows = review.rules.filter(reviewProject).map(rule => {
    const bonus = rule.kind === 'commission';
    const actions = [];
    if (!closed) {
      if (!rule.archived) actions.push(button('Изменить','month-rule-edit:' + rule.id));
      actions.push(button('Остановить','month-rule-stop:' + rule.id));
      if (!rule.archived && !rule.manual && rule.plan !== null && rule.plan !== (rule.applied ?? 0)) {
        actions.push(button(rule.plan ? 'Внести в план' : 'Убрать из плана','month-plan-apply:' + rule.id));
      }
      if (bonus && rule.calculated > 0 && rule.calculated !== rule.posted) actions.push(button('Подтвердить премию','month-bonus-confirm:' + rule.id,true));
      if (bonus && rule.posted) actions.push(button('Снять подтверждение','month-bonus-clear:' + rule.id));
    }
    const formula = bonus ? `${new Intl.NumberFormat('ru-RU').format(rule.value/100)}% · ${esc(rule.income_article || 'Поступления по проекту')}` : 'Фиксированный расход в месяц';
    return `<tr><td class="wrap"><strong>${esc(rule.project)} · ${esc(rule.article)}</strong><small>${formula}</small></td>
      <td>${monthMoney(rule.plan)}${rule.manual ? '<small>Задан ручной план</small>' : rule.plan === null ? '<small>Нужен план поступлений в БДДС</small>' :
        rule.applied !== null ? `<small>В бюджете ${rub(rule.applied)}</small>` : ''}
        ${!bonus ? `<small>Факт ${rub(rule.recorded)}</small>` : ''}</td>
      <td>${bonus ? `${rub(rule.calculated)}<small>База ${rub(rule.base)}</small>
        ${rule.posted ? `<small>Подтверждено ${rub(rule.posted)} на ${esc(rule.posted_cutoff)}</small>` : ''}` : '—'}</td>
      <td>${bonus ? rub(rule.paid) : '—'}</td><td><strong>${bonus ? rub(rule.due) : '—'}</strong></td>
      <td><div class="actions month-rule-actions">${actions.join('')}</div></td></tr>`;
  });
  return `<section class="month-stack" id="month-rules"><div class="row"><div><h2>Правила проекта и премии</h2>
      <small>Премии рассчитаны по разнесённым поступлениям по ${monthDateLabel(scope.day)} включительно</small></div>
      <div class="actions">${closed ? '' : button('+ Правило','month-rule-edit',true) + button('+ План поступлений','plan:БДДС')}</div></div>
      ${table('Расчёт по правилам',['Правило','Расчёт плана БДР','Премия по формуле','Выплачено по статье','К выплате по формуле',''],rows,
      'Добавьте фиксированный расход или процент от поступлений по проекту.')}
      ${earlier.length ? `<details class="month-details"><summary>Подтверждённые премии прошлых месяцев</summary>
        ${table('Выплаты на дату среза',['Месяц','Проект и статья','Подтверждено','Выплачено','Осталось'],earlier)}</details>` : ''}</section>`;
}

function monthTasks(review) {
  const rows = review.actions.filter(row => !row.project || projectInScope(row.project)).map(row => `<tr>
    <td>${esc(row.day)}</td><td class="wrap">${esc(row.title)}<small>${esc([row.project,row.assignee].filter(Boolean).join(' · '))}</small></td>
    <td><span class="pill ${row.done ? '' : 'pending'}">${row.done ? 'Готово' : 'В работе'}</span></td>
    <td>${button('Изменить','month-action-edit:' + row.id)} ${button(row.done ? 'Вернуть в работу' : 'Готово','month-action-status:' + row.id)}</td></tr>`);
  return `<section class="month-stack" id="month-actions">${table('Действия на неделю',['Срок','Действие','Статус',''],rows,
    'Добавьте конкретное действие, срок и ответственного.',button('+ Действие','month-action-edit',true))}</section>`;
}

function monthDetails(scope, review) {
  const closed = data.periodClosures.some(row => row.entity === scope.entity && row.month === scope.month);
  return monthCashSection(scope,review,closed) + monthPnl(scope,closed) + monthRules(scope,review,closed) + monthTasks(review);
}

function monthRuleEditor(scope, rule) {
  const expense = articlesFor('expense',true).map(name => [name,name]);
  const sources = articlesFor('income').filter(name => !nonOperating.includes(name)).map(name => [name,name]);
  const placeholder = (items,label = 'Выберите') => [['',label],...items];
  const keys = rule
    ? `<p>${esc(rule.project)} · ${esc(rule.article)}</p>`
    : `<div class="fields">${selectField('Проект','project',placeholder(activeProjects().map(name => [name,name])),project)}
        ${selectField('Статья расхода','article',placeholder(expense))}</div>`;
  const form = modal(rule ? 'Изменить правило' : 'Новое правило', `<p class="subtitle">
    ${esc(entityName(scope.entity))} · Действует с ${esc(scope.month)}</p>${keys}
    ${selectField('Тип правила','kind',[['commission','Процент от поступлений'],['fixed','Фиксированный расход в месяц']],rule?.kind)}
    <div class="fields"><div id="rulePercent">${field('Процент','percent','number',rule?.kind === 'commission' ? rule.value/100 : '5',
      'min="0.01" max="100" step="0.01" required') }</div>
      <div id="ruleSource">${selectField('Статья поступлений','incomeArticle',placeholder(sources,'Все операционные поступления'),rule?.income_article || '',false)}</div>
      <div id="ruleFixed">${field('В месяц, ₽','fixed','number',rule?.kind === 'fixed' ? rule.value/100 : '', 'min="0.01" step="0.01" required')}</div></div>
    <small id="ruleHelp"></small>`, values => api('monthly-rule',{
    ...scope,...Object.fromEntries(values),project:rule?.project || values.get('project'),article:rule?.article || values.get('article'),
    value:values.get(values.get('kind') === 'fixed' ? 'fixed' : 'percent'),
    expected:rule ? [rule.id,rule.kind,rule.value,rule.income_article] : null
  }));
  const update = () => {
    const commission = form.elements.kind.value === 'commission';
    const toggle = (id,name,show) => {
      form.querySelector('#' + id).hidden = !show;
      form.elements[name].disabled = !show;
    };
    toggle('ruleSource','incomeArticle',commission);
    toggle('rulePercent','percent',commission);
    toggle('ruleFixed','fixed',!commission);
    form.querySelector('#ruleHelp').textContent = commission
      ? 'Для выплат используйте эту же статью расхода и выберите месяц в поле «Оплата премии за месяц».'
      : 'Сумма рассчитывается для бюджета БДР. Факт появится после начисления расхода.';
  };
  form.elements.kind.onchange = update;
  update();
}

function monthExpectation(scope, row) {
  modal(row ? 'Изменить ожидаемое движение' : 'Ожидаемое движение', `
    <p>${esc(entityName(scope.entity))}</p>
    ${selectField('Проект','project',[['','Компания'],...activeProjects(row?.project ? [row.project] : []).map(name => [name,name])],row ? row.project : project,false)}
    <div class="fields">${field('Дата','day','date',row?.day || scope.day,'required')}
    ${field('Сумма, ₽','amount','number',row ? row.amount/100 : '','step="0.01" required')}</div>
    ${field('Назначение','description','text',row?.description || '','maxlength="200" required')}
    <small>Поступление укажите со знаком плюс, выплату со знаком минус.</small>`, values =>
    api('forecast',{...Object.fromEntries(values),entity:scope.entity,id:row?.id}));
}

function weeklyActionEditor(scope, row) {
  modal(row ? 'Изменить действие' : 'Новое действие на неделю', `
    ${field('Что сделать','title','text',row?.title || '','maxlength="300" required')}
    <div class="fields">${field('Срок','day','date',row?.day || scope.day,'required')}
      ${field('Ответственный','assignee','text',row?.assignee || '','maxlength="100"')}
      ${selectField('Проект','project',[['','Компания'],...activeProjects(row?.project ? [row.project] : []).map(name => [name,name])],
      row ? row.project : project,false)}</div>`, values =>
    api('weekly-action-save',{...Object.fromEntries(values),id:row?.id,entity:scope.entity}));
}

function workingMonthAction(kind,arg) {
  if (!kind.startsWith('month-')) return false;
  const scope = workingMonthScope();
  const id = Number(arg);
  const review = monthReview?.result;
  const rule = review?.rules.find(item => item.id === id);
  const item = review?.actions.find(row => row.id === id);
  const forecastRow = data.forecast_entries.find(row => row.id === id);
  const sendRule = action => api(action,{...scope,id,token:rule.token});
  if (kind === 'month-date') {
    reviewDate = arg;
    render();
  }
  if (kind === 'month-rule-edit') monthRuleEditor(scope,rule);
  if (kind === 'month-rule-stop' && rule) modal('Остановить правило',
    `<p>${esc(rule.project)} · ${esc(rule.article)}. Правило перестанет действовать с ${esc(scope.month)}. Сохранённый план можно изменить в БДР.</p>`,
    () => api('monthly-rule',{...scope,kind:'off',project:rule.project,article:rule.article,
      expected:[rule.id,rule.kind,rule.value,rule.income_article]}));
  if (kind === 'month-plan-apply' && rule) modal('Обновить план БДР',
    `<p>${esc(rule.project)} · ${esc(rule.article)} · ${rub(rule.plan)}</p><small>Текущий план за ${esc(scope.month)} · ${esc(scope.scenario)}</small>`,
    () => sendRule('monthly-rule-plan'));
  if (kind === 'month-bonus-confirm' && rule) modal('Подтвердить начисление премии',
    `<p>${esc(rule.project)} · ${rub(rule.calculated)}</p>
      <small>Расчёт по поступлениям на ${esc(scope.day)}. В БДР учитываются начисления по той же статье.</small>`,
    () => sendRule('bonus-confirm'));
  if (kind === 'month-bonus-clear' && rule) modal('Снять подтверждение премии',
    `<p>${esc(rule.project)} · ${rub(rule.posted)}</p><small>В БДР останутся ручные и банковские начисления по статье.</small>`,
    () => sendRule('bonus-clear'));
  if (kind === 'month-plan-edit') budgetEntry('plan','БДР',data.plans.find(row => row.id === id));
  if (kind === 'month-plan-remove') modal('Удалить строку бюджета','<p>Строка будет удалена из текущего плана.</p>',
    () => api('remove-plan',{id}));
  if (kind === 'month-action-edit') weeklyActionEditor(scope,item);
  if (kind === 'month-action-status' && item) {
    modal(item.done ? 'Вернуть действие в работу' : 'Отметить действие выполненным',`<p>${esc(item.title)}</p>`,
      () => api('weekly-action-status',{entity:scope.entity,id,done:!item.done}));
  }
  if (kind === 'month-forecast') monthExpectation(scope,forecastRow);
  if (kind === 'month-forecast-done' && forecastRow) modal('Движение исполнено',
    `<p>${esc(forecastRow.description)} · ${rub(forecastRow.amount)}</p><small>Строка уйдёт из прогноза. Банковский факт отображается по выписке.</small>`,
    () => api('remove-forecast',{id}));
  if (kind === 'month-fund') {
    const fund = data.funds.find(row => row.id === id);
    modal('Высвободить деньги из фонда',`<p>${esc(fund.name)} · ${esc(entityName(fund.entity))}</p>
      <div class="fields">${field('Дата','day','date',scope.day,'required')}
        ${field('Сумма, ₽','amount','number','','min="0.01" step="0.01" required')}</div>
      ${field('Основание','note','text','','maxlength="200" required')}
      <small>Изменится сумма денег, зарезервированных в этом ООО.</small>`,
    values => api('fund-entry',{...Object.fromEntries(values),fund:id,direction:'release'}));
  }
  return true;
}
