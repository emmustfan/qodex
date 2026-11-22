const content = document.querySelector('#content');
const dialog = document.querySelector('#dialog');
const nav = document.querySelector('#nav');
const RUB = new Intl.NumberFormat('ru-RU', {style:'currency',currency:'RUB',maximumFractionDigits:2,minimumFractionDigits:0});
const MONTHS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const tabs = [['overview','▦','Обзор'],['operations','⇄','Операции'],['cash','▤','БДДС'],['calendar','▧','Платёжный календарь'],['forecast','↗','Прогноз денег'],['profit','▥','БДР / P&L'],['requests','✓','Заявки'],['accounts','▱','Счета']];
const nonOperating = ['Финансирование','Дивиденды'];
let data;
let view = 'overview';
let period = new Date().toISOString().slice(0,7);
let project = '';
let entity = '';
let account = '';
let scenario = 'Базовый';
let version = '';
let operationFilter = 'all';
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const rub = cents => RUB.format(cents / 100);
const sign = cents => cents < 0 ? 'negative' : cents > 0 ? 'positive' : '';
const options = (items, selected) => items.map(item => `<option ${item === selected ? 'selected' : ''}>${esc(item)}</option>`).join('');
const finance = () => data.role === 'finance';
const button = (label, action, primary = false) => `<button class="button ${primary ? 'primary' : ''}" data-action="${action}">${label}</button>`;
const card = (label, value, note) => `<article class="card metric"><div class="metric-label">${label}</div><strong>${value}</strong><small>${note}</small></article>`;
const table = (title, headings, rows, empty = 'За выбранный период записей нет.', action = '') => `<section class="card table-card"><div class="card-head"><h2>${title}</h2>${action}</div>${rows.length ? `<div class="scroll"><table><thead><tr>${headings.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty">${empty}</p>`}</section>`;

async function api(action, payload) {
  const response = await fetch('/api/' + action, payload ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)} : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка запроса.');
  return result;
}

const entityName = id => data.entities[id - 1] || 'Без ООО';
const bank = id => data.accounts.find(item => item.id === id);
const bankName = id => {
  const item = bank(id);
  return item ? entityName(item.entity) + ' · ' + item.name : 'Без счёта';
};
const inEntity = id => !entity || Number(entity) === id;
const inScope = id => inEntity(bank(id)?.entity) && (!account || Number(account) === id);
const transferMap = () => new Map(data.transfers.flatMap(({outgoing,incoming}) => [[outgoing,incoming],[incoming,outgoing]]));

function cashRows(includeTransfers = false) {
  const byOperation = Map.groupBy(data.allocations, row => row.operation);
  const paired = transferMap();
  const byId = new Map(data.operations.map(op => [op.id,op]));
  return data.operations.filter(op => {
    if (!inScope(op.account)) return false;
    if (includeTransfers || account || !paired.has(op.id)) return true;
    const other = byId.get(paired.get(op.id));
    return entity && bank(other.account)?.entity !== bank(op.account)?.entity;
  }).flatMap(op => {
    const other = byId.get(paired.get(op.id));
    const article = !other ? 'Без распределения' : bank(other.account)?.entity === bank(op.account)?.entity ? 'Между счетами' : 'Между ООО';
    const lines = byOperation.get(op.id) || [{amount:op.amount,project:'',article}];
    return lines.map(row => ({...row, month:op.day.slice(0,7),day:op.day,account:op.account}));
  });
}

function profitRows() {
  const byId = new Map(data.operations.map(op => [op.id,op]));
  const matched = data.allocations.filter(row => row.accrual && !nonOperating.includes(row.article) && inEntity(bank(byId.get(row.operation)?.account)?.entity));
  return [...matched.map(row => ({...row,month:row.accrual})), ...data.accruals.filter(row => inEntity(row.entity))];
}

function totals(rows) {
  return rows.reduce((total,row) => {
    if (row.amount > 0) total.incoming += row.amount;
    else total.outgoing -= row.amount;
    total.net += row.amount;
    return total;
  }, {incoming:0,outgoing:0,net:0});
}

function filterRows(rows, month = period, currentProject = project) {
  return rows.filter(row => row.month === month && (!currentProject || row.project === currentProject));
}

function header(title, subtitle, actions = '') {
  return `<header class="top"><div><div class="eyebrow">${data.demo ? 'Демонстрационный режим' : 'Финансовый контур'}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${actions}</div></header>`;
}

const idOptions = (items, current) => items.map(([id,label]) => `<option value="${id}" ${String(id) === String(current) ? 'selected' : ''}>${esc(label)}</option>`).join('');
const legalOptions = () => data.entities.map((name,index) => [index + 1,name]);
const accountOptions = () => data.accounts.filter(item => inEntity(item.entity)).map(item => [item.id,bankName(item.id)]);
const selectField = (label,name,items,current) => `<label>${label}<select name="${name}" aria-label="${esc(label)}" required>${idOptions(items,current)}</select></label>`;

function filters(withScenario = false, operations = false, showAccount = true) {
  return `<div class="toolbar"><input type="month" aria-label="Отчётный месяц" id="period" value="${period}"><select id="project" aria-label="Проект"><option value="">Все проекты</option>${options(data.projects,project)}</select><select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select>${showAccount ? `<select id="bankAccount" aria-label="Банковский счёт"><option value="">Все счета</option>${idOptions(accountOptions(),account)}</select>` : ''}${withScenario ? `<select id="scenario" aria-label="Сценарий бюджета">${options(data.scenarios,scenario)}</select>` : ''}${operations ? `<select id="operationFilter" aria-label="Статус распределения"><option value="all">Все операции</option><option value="pending" ${operationFilter === 'pending' ? 'selected' : ''}>Без распределения</option></select>` : ''}</div>`;
}

function chart(rows) {
  const date = new Date(period + '-01T12:00:00Z');
  const groups = [];
  for (let offset = 5; offset >= 0; offset--) {
    const start = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth() - offset,1));
    const key = start.toISOString().slice(0,7);
    groups.push({...totals(filterRows(rows,key)),name:MONTHS[start.getUTCMonth()]});
  }
  const peak = Math.max(10000,...groups.flatMap(x => [x.incoming,x.outgoing]));
  return `<div class="chart"><div class="axis">${[1,.75,.5,.25,0].map(x => `<span>${new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(x * peak / 100)} ₽</span>`).join('')}</div><div class="chart-main">${groups.map(group => `<div class="group"><div class="bars" aria-label="${group.name}: поступления ${rub(group.incoming)}, выплаты ${rub(group.outgoing)}"><div class="bar" title="${rub(group.incoming)}" style="height:${group.incoming / peak * 100}%"></div><div class="bar out" title="${rub(group.outgoing)}" style="height:${group.outgoing / peak * 100}%"></div></div><small>${group.name}</small></div>`).join('')}</div></div>`;
}

function operationTable(compact = false) {
  const paired = transferMap();
  const items = data.operations.filter(op => {
    if (!inScope(op.account)) return false;
    const lines = data.allocations.filter(item => item.operation === op.id);
    return op.day.startsWith(period) && (!project || lines.some(line => line.project === project)) && (operationFilter !== 'pending' || compact || (!lines.length && !paired.has(op.id)));
  }).sort((a,b) => b.day.localeCompare(a.day) || b.id-a.id);
  const rows = (compact ? items.slice(0,5) : items).map(op => {
    const lines = data.allocations.filter(line => line.operation === op.id && (!project || project === line.project));
    const amount = project ? totals(lines).net : op.amount;
    return `<tr><td>${esc(op.day)}</td><td class="wrap">${esc(op.description)}<small>${esc(bankName(op.account))}</small></td><td>${paired.has(op.id) ? '<span class="pill">Внутренний перевод</span>' : lines.length ? esc([...new Set(lines.map(line => line.project))].join(', ')) : '<span class="pill pending">Без распределения</span>'}</td><td class="${sign(amount)}">${rub(amount)}</td><td>${paired.has(op.id) ? button('Отвязать','unlink-transfer:' + op.id) : button(lines.length ? 'Открыть' : 'Распределить','allocate:' + op.id)} ${!op.account ? button('Указать счёт','assign-account:' + op.id) : ''}</td></tr>`;
  });
  return table(compact ? 'Последние операции' : 'Банковские операции',['Дата','Назначение','Проект','Сумма',''],rows,'Операций за выбранный месяц нет.',compact ? button('Все операции','view:operations') : '');
}

function overview() {
  const cash = cashRows();
  const current = totals(filterRows(cash));
  const result = totals(filterRows(profitRows()));
  const opening = !entity && !account && data.balances.find(row => row.project === project && row.day.slice(0,7) <= period);
  const selectedAccounts = data.accounts.filter(item => inScope(item.id));
  const starts = new Map(data.account_balances.filter(row => row.day.slice(0,7) <= period).map(row => [row.account,row]));
  const reconciled = !project && selectedAccounts.length > 0 && selectedAccounts.every(item => starts.has(item.id)) && (entity || account || data.operations.every(op => op.account || op.day.slice(0,7) > period));
  const history = cashRows(true).filter(row => row.month <= period && (!project || row.project === project));
  const cumulative = reconciled ? selectedAccounts.reduce((sum,item) => {
    const start = starts.get(item.id);
    return sum + start.amount + totals(history.filter(row => row.account === item.id && row.day >= start.day)).net;
  },0) : (opening?.amount ?? 0) + totals(history.filter(row => !opening || row.day >= opening.day)).net;
  const costs = totals(filterRows(cash,period,'Офис')).outgoing;
  const impact = data.projects.map(name => ({name,...totals(filterRows(cash,period,name))}));
  const maximum = Math.max(1,...impact.map(item => item.incoming + item.outgoing));
  return header('Обзор финансов','Движение денег и результат по проектам',(account ? button('Входящий остаток','account-balance:' + account) : !entity ? button('Входящий остаток','balance') : button('Счета и остатки','view:accounts')) + button('↑ Импорт выписки','import') + button('+ Новая заявка','request',true)) + filters()
    + `<div class="metrics">${card(reconciled ? 'Остаток по счетам' : opening ? (project ? 'Остаток по проекту' : 'Остаток группы') : 'Чистый поток накопленно',rub(cumulative),reconciled ? 'С учётом входящих остатков по счетам' : opening ? `Входящий остаток на ${esc(opening.day)}` : 'С начала загруженной истории')}${card('Поступления',rub(current.incoming),'Факт за месяц')}${card('Выплаты',rub(current.outgoing),'Факт за месяц')}${card('Результат БДР',rub(result.net),result.incoming ? `Рентабельность ${(result.net/result.incoming*100).toFixed(1)}%` : 'Рентабельность без выручки не считается')}</div>
    <div class="panels"><section class="card"><div class="card-head"><div><h2>Движение денег</h2><small>Шесть месяцев до выбранного периода</small></div><div class="legend"><span><i class="dot"></i>Поступления</span><span><i class="dot out"></i>Выплаты</span></div></div>${chart(cash)}</section>
    <section class="card"><div class="card-head"><div><h2>Проекты и офис</h2><small>Офисные выплаты за месяц · ${rub(costs)}</small></div></div>${impact.map(item => `<div class="project"><div class="row"><strong>${esc(item.name)}</strong><strong class="${sign(item.net)}">${rub(item.net)}</strong></div><small>Пришло ${rub(item.incoming)} · Ушло ${rub(item.outgoing)}</small><div class="track"><span style="width:${(item.incoming + item.outgoing) / maximum * 100}%"></span></div></div>`).join('')}</section></div>` + operationTable(true);
}

function report(basis) {
  const cash = basis === 'БДДС';
  const fact = filterRows(cash ? cashRows() : profitRows());
  if (cash && account) {
    const actual = totals(fact);
    const rows = [...new Set(fact.map(row => row.article))].map(article =>
      `<tr><td>${esc(article)}</td><td>${rub(totals(fact.filter(row => row.article === article)).net)}</td></tr>`);
    return header('БДДС',esc(bankName(Number(account))) + ' · факт по датам платежей') + filters()
      + `<div class="metrics">${card('Чистый денежный поток',rub(actual.net),'Факт за месяц')}${card('Поступления',rub(actual.incoming),'Факт за месяц')}${card('Выплаты',rub(actual.outgoing),'Факт за месяц')}</div>`
      + table('Движение по статьям',['Статья','Факт'],rows);
  }
  let budget = filterRows(data.plans.filter(row => row.basis === basis && row.scenario === scenario && inEntity(row.entity)));
  if (cash && scenario === data.scenarios[0]) {
    budget.push(...filterRows(data.requests.filter(item => item.status === 'Согласована' && inEntity(item.entity)).map(item => ({...item,month:item.day.slice(0,7),amount:-item.amount}))));
  }
  const versions = data.budget_versions.filter(item => item.month === period && item.basis === basis && item.scenario === scenario);
  const saved = versions.find(item => item.id === Number(version));
  if (saved) budget = filterRows(saved.rows.filter(row => inEntity(row.entity)));
  const versionFilter = `<div class="toolbar"><select id="version" aria-label="Версия плана"><option value="">Текущий план</option>${idOptions(versions.map(item => [item.id,item.name]),version)}</select></div>`;
  const planActions = saved ? '' : button('+ Строка плана','plan:' + basis,true) + button('Зафиксировать план','freeze-budget:' + basis);
  const actual = totals(fact), planned = totals(budget);
  const direct = fact.filter(row => row.project !== 'Офис');
  const directTotals = totals(direct);
  const office = totals(fact.filter(row => row.project === 'Офис'));
  const trans = new Set([...budget,...fact].map(row => row.article));
  const rows = [...trans].map(article => {
    const actualAmount = totals(fact.filter(row => row.article === article)).net;
    const plannedAmount = totals(budget.filter(row => row.article === article)).net;
    return `<tr><td>${esc(article)}</td><td>${rub(plannedAmount)}</td><td>${rub(actualAmount)}</td><td class="${sign(actualAmount-plannedAmount)}">${rub(actualAmount-plannedAmount)}</td></tr>`;
  });
  const extras = cash ? '' : table('Ручные начисления',['Период','Проект','Описание','Сумма'],filterRows(data.accruals.filter(row => inEntity(row.entity))).map(item => `<tr><td>${esc(item.month)}</td><td>${esc(item.project)}</td><td class="wrap">${esc(item.description)}</td><td>${rub(item.amount)}</td></tr>`));
  return header(cash ? 'БДДС' : 'БДР / P&L',cash ? 'План и факт по датам платежей' : 'План и факт по месяцам начисления',planActions + (cash ? '' : button('+ Начисление','accrual'))) + filters(true,false,cash) + versionFilter
    + `<div class="metrics">${card(cash ? 'Чистый денежный поток' : 'Операционный результат',rub(actual.net),`План ${rub(planned.net)}`)}${card(cash ? 'Поступления' : 'Доходы',rub(actual.incoming),`План ${rub(planned.incoming)}`)}${card(cash ? 'Выплаты' : 'Расходы',rub(actual.outgoing),`План ${rub(planned.outgoing)}`)}${cash ? card('Отклонение потока',rub(actual.net-planned.net),'Факт минус план') : card('Маржа проектов',directTotals.incoming ? `${(directTotals.net/directTotals.incoming*100).toFixed(1)}%` : '—',`Офисные расходы · ${rub(office.outgoing)}`)}</div>`
    + table('План-факт по статьям',['Статья','План','Факт','Отклонение'],rows) + (extras ? '<div style="height:15px"></div>' + extras : '');
}

const dueDate = item => item.payment_day || item.day;
const outstanding = item => item.amount - item.paid;

function paymentStatus(item) {
  if (item.status !== 'Согласована' || !item.paid) return item.status;
  return outstanding(item) ? 'Частично оплачена' : 'Оплачена';
}

function requestActions(item) {
  if (!finance()) return '';
  if (item.status === 'На согласовании' && (data.demo || item.author !== data.user)) {
    return button('Решение','review:' + item.id);
  }
  return item.status === 'Согласована' ? button('Оплаты','payments:' + item.id) : '';
}

function requests() {
  const rows = [...data.requests].sort((a,b) => b.id-a.id).map(item =>
    `<tr><td class="wrap"><strong>${esc(item.title)}</strong><small>${esc(item.author)}</small></td><td>${esc(item.project)}</td><td>${esc(item.article)}</td><td>${esc(entityName(item.entity))}</td><td>${esc(dueDate(item))}</td><td>${rub(item.amount)}</td><td>${rub(item.paid)}</td><td><span class="pill ${item.status === 'На согласовании' ? 'pending' : ''}">${paymentStatus(item)}</span></td><td>${requestActions(item)}</td></tr>`);
  return header('Заявки на расходы','Согласованные заявки попадают в базовый план БДДС.',button('+ Новая заявка','request',true))
    + table(finance() ? 'Все заявки' : 'Мои заявки',['Назначение','Проект','Статья','ООО','Дата оплаты','Сумма','Оплачено','Статус',''],rows,'Заявок пока нет.');
}

function calendar() {
  const today = new Date().toLocaleDateString('sv-SE');
  const open = data.requests.filter(item => item.status === 'Согласована'
    && outstanding(item) && inEntity(item.entity) && (!project || item.project === project));
  const due = open.filter(item => dueDate(item).startsWith(period));
  const late = open.filter(item => dueDate(item) < today);
  const amount = items => items.reduce((sum,item) => sum + outstanding(item),0);
  const rows = items => [...items].sort((a,b) => dueDate(a).localeCompare(dueDate(b)) || a.id-b.id).map(item =>
    `<tr><td>${esc(dueDate(item))}</td><td>${esc(entityName(item.entity))}</td><td class="wrap">${esc(item.title)}<small>${esc(item.project)}</small></td><td>${rub(item.paid)}</td><td>${rub(outstanding(item))}</td><td>${requestActions(item)} ${button('Перенести','reschedule:' + item.id)}</td></tr>`);
  const columns = ['Дата оплаты','ООО','Заявка','Оплачено','К оплате',''];
  return header('Платёжный календарь','Неоплаченные остатки согласованных заявок') + filters(false,false,false)
    + `<div class="metrics">${card('К оплате за месяц',rub(amount(due)),`Заявок: ${due.length}`)}${card('Просрочено',rub(amount(late)),`Заявок: ${late.length}`)}</div>`
    + table('К оплате в выбранном месяце',columns,rows(due),'На этот месяц платежей нет.')
    + '<div class="calendar-gap"></div>' + table('Просроченные платежи',columns,rows(late),'Просроченных платежей нет.');
}

function forecast() {
  const today = new Date().toLocaleDateString('sv-SE');
  const horizon = period < today.slice(0,7) ? today.slice(0,7) : period;
  const scope = data.accounts.filter(item => inEntity(item.entity));
  const opening = new Map(data.account_balances.filter(row => row.day <= today).map(row => [row.account,row]));
  const unassigned = !entity && data.operations.some(op => !op.account && op.day <= today);
  const known = scope.length && scope.every(item => opening.has(item.id)) && !unassigned;
  let running = known ? scope.reduce((sum,item) => {
    const start = opening.get(item.id);
    return sum + start.amount + totals(data.operations.filter(op =>
      op.account === item.id && op.day >= start.day && op.day <= today)).net;
  },0) : null;
  const initial = running;
  const manual = data.forecast_entries.filter(row => inEntity(row.entity) && row.day.slice(0,7) <= horizon);
  const obligations = data.requests.filter(item => item.status === 'Согласована' && inEntity(item.entity)
    && outstanding(item) && dueDate(item).slice(0,7) <= horizon).map(item => ({
      day:dueDate(item),amount:-outstanding(item)
    }));
  const buckets = Map.groupBy([...manual,...obligations], item => item.day < today ? today : item.day);
  let minimum = initial;
  const rows = [...buckets.keys()].sort().map(day => {
    const dayTotal = totals(buckets.get(day));
    if (known) {
      running += dayTotal.net;
      minimum = Math.min(minimum,running);
    }
    return `<tr><td>${esc(day)}</td><td>${rub(dayTotal.incoming)}</td><td>${rub(dayTotal.outgoing)}</td><td class="${sign(running)}">${known ? rub(running) : '—'}</td></tr>`;
  });
  const formats = value => known ? rub(value) : '—';
  const items = [...manual].sort((a,b) => a.day.localeCompare(b.day) || a.id-b.id).map(item =>
    `<tr><td>${esc(item.day)}</td><td>${esc(entityName(item.entity))}</td><td class="wrap">${esc(item.description)}</td><td>${rub(item.amount)}</td><td>${button('Удалить','remove-forecast:' + item.id)}</td></tr>`);
  return header('Прогноз денег','Факт по счетам на сегодня, ожидаемые операции и остатки заявок',button('+ Ожидаемая операция','forecast',true))
    + `<div class="toolbar"><input type="month" aria-label="Горизонт прогноза" id="period" min="${today.slice(0,7)}" value="${horizon}"><select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select></div>
      <div class="metrics">${card('Остаток на сегодня',formats(initial),known ? 'С учётом банковских операций' : 'Проверьте входящие остатки и счета')}${card('Остаток на конец периода',formats(running),`Горизонт ${horizon}`)}${card('Минимальный остаток',formats(minimum),minimum < 0 ? 'Прогнозируется кассовый разрыв' : 'На горизонте прогноза')}${card('К оплате по заявкам',rub(totals(obligations).outgoing),'Только неоплаченные суммы')}</div>`
    + table('Остаток по дням',['Дата','Поступления','Выплаты','Остаток'],rows,'Ожидаемых движений до конца периода нет.')
    + '<div class="calendar-gap"></div>'
    + table('Операции, добавленные вручную',['Дата','ООО','Назначение','Сумма',''],items,'Ручных операций до конца периода нет.');
}

function payments(item) {
  const linked = data.request_payments.filter(row => row.request === item.id);
  const existing = linked.map(row => data.operations.find(op => op.id === row.operation));
  const used = new Set(data.request_payments.map(row => row.operation));
  const paired = transferMap();
  const candidates = data.operations.filter(op => {
    if (bank(op.account)?.entity !== item.entity || op.amount >= 0
      || -op.amount > outstanding(item) || used.has(op.id) || paired.has(op.id)) return false;
    return data.allocations.filter(row => row.operation === op.id)
      .every(row => row.project === item.project && row.article === item.article);
  }).sort((a,b) => b.day.localeCompare(a.day));
  const summary = `<p class="subtitle">${esc(item.title)} · оплачено ${rub(item.paid)} · к оплате ${rub(outstanding(item))}</p>`;
  const describe = op => `${op.day} · ${bankName(op.account)} · ${rub(-op.amount)} · ${op.description}`;
  const history = existing.length ? `<ul class="payment-list">${existing.map(op =>
    `<li>${esc(describe(op))} <button class="button" type="button" data-detach="${op.id}">Отвязать</button></li>`).join('')}</ul>` : '';
  const form = modal('Оплаты по заявке',summary + history + (candidates.length
    ? selectField('Списание','operation',candidates.map(op => [op.id,describe(op)]))
      + '<small>Связь учитывает полную сумму списания. Если статья ещё не задана, она берётся из заявки. Месяц БДР задаётся в операции.</small>'
    : '<p>Доступных списаний для привязки нет.</p>'),
  values => api('link-payment',{request:item.id,operation:values.get('operation')}));
  const submit = form.querySelector('[type=submit]');
  submit.hidden = !candidates.length;
  submit.textContent = 'Привязать списание';
  form.addEventListener('click',event => {
    const control = event.target.closest('[data-detach]');
    if (!control) return;
    dialog.close();
    modal('Отвязать списание','<p>Сумма снова появится к оплате. Распределение банковской операции сохранится.</p>',
      () => api('unlink-payment',{operation:control.dataset.detach}));
  });
}

function accountReport() {
  const titles = {opening:'Входящий остаток',incoming:'Поступления',outgoing:'Выплаты',closing:'Исходящий остаток'};
  const rows = data.accounts.filter(item => inScope(item.id)).map(item => {
    const start = data.account_balances.find(row => row.account === item.id && row.day <= period + '-01');
    const ops = data.operations.filter(op => op.account === item.id && op.day.startsWith(period));
    const control = data.statement_controls.find(row => row.account === item.id && row.month === period);
    const flow = totals(ops);
    const opening = start ? start.amount + totals(data.operations.filter(op =>
      op.account === item.id && op.day >= start.day && op.day < period + '-01')).net : null;
    const actual = {...flow,opening,closing:opening === null ? null : opening + flow.net};
    const differences = Object.keys(titles).filter(key => control && actual[key] !== null && actual[key] !== control[key]);
    const status = !control ? 'Нет итогов выписки' : differences.length ? 'Есть расхождения'
      : !start ? 'Укажите входящий остаток' : 'Сверено';
    const money = value => value == null ? '—' : rub(value);
    const details = differences.length ? differences.map(key =>
      `<small>${titles[key]} · учёт − банк ${rub(actual[key] - control[key])}</small>`).join('') : '';
    const cell = key => `<td>${money(actual[key])}${control ? `<small>Банк ${rub(control[key])}</small>` : ''}</td>`;
    return `<tr><td class="wrap"><strong>${esc(item.name)}</strong><small>${esc(entityName(item.entity))}</small></td>
      ${Object.keys(titles).map(cell).join('')}
      <td class="wrap"><span class="pill ${status === 'Сверено' ? '' : 'pending'}">${status}</span>${details}</td>
      <td>${button('Входящий остаток','account-balance:' + item.id)} ${button('Итоги выписки','statement-control:' + item.id)}</td></tr>`;
  });
  return header('Банковские счета','Остатки, обороты и сверка с выписками',button('+ Счёт','account',true))
    + `<div class="toolbar"><input type="month" aria-label="Отчётный месяц" id="period" value="${period}">
       <select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select>
       <select id="bankAccount" aria-label="Банковский счёт"><option value="">Все счета</option>${idOptions(accountOptions(),account)}</select></div>`
    + table('Сверка за месяц',['Счёт',...Object.values(titles),'Статус',''],rows,'В выбранном разрезе счетов нет.');
}

function render() {
  if (!finance()) view = 'requests';
  if (view === 'profit' || view === 'calendar') account = '';
  nav.innerHTML = '<p class="nav-label">РАЗДЕЛЫ</p>' + tabs.filter(([key]) => finance() || key === 'requests').map(([key,icon,text]) => `<button data-action="view:${key}" class="${view === key ? 'nav-active' : ''}" ${view === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${text}</button>`).join('');
  document.querySelector('#account').innerHTML = `<span class="avatar" aria-hidden="true">${esc(data.user[0])}</span><div>${esc(data.user)}<small>${finance() ? 'Финансист' : 'Сотрудник'}</small></div>`;
  if (view === 'overview') content.innerHTML = overview();
  if (view === 'operations') content.innerHTML = header('Операции','Банковская выписка и распределение по проектам',button('Связать перевод','transfer') + button('↑ Импорт выписки','import',true)) + filters(false,true) + operationTable();
  if (view === 'cash') content.innerHTML = report('БДДС');
  if (view === 'profit') content.innerHTML = report('БДР');
  if (view === 'requests') content.innerHTML = requests();
  if (view === 'calendar') content.innerHTML = calendar();
  if (view === 'forecast') content.innerHTML = forecast();
  if (view === 'accounts') content.innerHTML = accountReport();
}

const field = (label, name, type, value = '', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const picker = (label, name, items, value) => `<label>${label}<select name="${name}">${options(items,value)}</select></label>`;

function modal(title, fields, handler) {
  dialog.innerHTML = `<form><div class="row"><h2>${title}</h2><button class="button" type="button" data-close aria-label="Закрыть">×</button></div>${fields}<div class="error" role="alert"></div><div><button class="button primary" type="submit">Сохранить</button></div></form>`;
  const form = dialog.querySelector('form');
  form.querySelector('[data-close]').onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const note = await handler(new FormData(form),form,event.submitter);
      data = await api('state');
      dialog.close();
      render();
      notify(note || 'Изменения сохранены.');
    } catch (error) {
      form.querySelector('.error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  dialog.showModal();
  return form;
}

function notify(message) {
  clearTimeout(toastTimer);
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toastTimer = setTimeout(() => {toast.textContent = '';},4500);
}

function allocation(op) {
  const previous = data.allocations.filter(item => item.operation === op.id);
  const makeRow = (line = {}) => `<div class="split">${picker('Проект','project',data.projects,line.project || project)}${picker('Статья','article',data.articles,line.article || (op.amount < 0 ? 'Разработка' : 'Лицензии'))}${field('Сумма, ₽','amount','number',line.amount == null ? '' : line.amount / 100,'step="0.01" required')}${field('Месяц БДР','accrual','month',line.accrual || '')}<button type="button" class="button remove" aria-label="Удалить строку">×</button></div>`;
  const form = modal('Распределение операции',`<p class="subtitle">${esc(op.description)} · ${rub(op.amount)} · ${esc(op.day)}</p><small>Пустой месяц БДР оставляет строку только в БДДС. Для уже отражённого ручного начисления оставьте месяц пустым.</small><div id="lines">${(previous.length ? previous : [{amount:op.amount,accrual:op.day.slice(0,7)}]).map(makeRow).join('')}</div><div class="row"><button class="button" type="button" id="add-line">+ Доля проекта</button><strong id="remaining"></strong></div>`, async (_,form) => {
    const lines = [...form.querySelectorAll('.split')].map(row => Object.fromEntries([...row.querySelectorAll('input,select')].map(input => [input.name,input.value])));
    await api('allocate',{id:op.id,lines});
  });
  const remaining = () => {
    const assigned = [...form.querySelectorAll('[name=amount]')].reduce((total,input) => total + Math.round(Number(input.value) * 100),0);
    form.querySelector('#remaining').textContent = 'Осталось ' + rub(op.amount - assigned);
  };
  form.querySelector('#add-line').onclick = () => {
    form.querySelector('#lines').insertAdjacentHTML('beforeend',makeRow({accrual:op.day.slice(0,7)}));
    remaining();
  };
  form.addEventListener('click',event => {
    if (event.target.matches('.remove')) {
      event.target.closest('.split').remove();
      remaining();
    }
  });
  form.addEventListener('input',remaining);
  remaining();
}

function doAction(action) {
  const [kind,arg] = action.split(':');
  if (kind === 'view') {
    view = arg;
    version = '';
    render();
    return;
  }
  const defaultDate = period + '-01';
  const amount = (value = '',extra = '') => field('Сумма, ₽','amount','number',value,`step="0.01" required ${extra}`);
  const category = (articles = data.articles) => selectField('ООО','entity',legalOptions(),entity) + `<div class="fields">${picker('Проект','project',data.projects,project)}${picker('Статья','article',articles)}</div>`;
  const save = (title,fields) => modal(title,fields,values => api(kind,{...Object.fromEntries(values),basis:arg,scenario}));
  if (kind === 'allocate') allocation(data.operations.find(op => op.id === Number(arg)));
  if (kind === 'account') save('Новый счёт',selectField('ООО','entity',legalOptions(),entity)
    + field('Название счёта','name','text','','maxlength="80" required'));
  if (kind === 'account-balance') {
    const id = Number(arg);
    const existing = data.account_balances.find(row => row.account === id);
    modal('Входящий остаток по счёту',`<p class="subtitle">${esc(bankName(id))}. Остаток на начало дня.</p>`
      + field('Дата начала','day','date',existing?.day || defaultDate,'required') + amount(existing ? existing.amount / 100 : ''),
      values => api(kind,{...Object.fromEntries(values),account:id}));
  }
  if (kind === 'statement-control') {
    const id = Number(arg);
    const existing = data.statement_controls.find(row => row.account === id && row.month === period);
    const controlField = (label,key) => field(label,key,'number',existing ? existing[key] / 100 : '',`step="0.01" required ${['incoming','outgoing'].includes(key) ? 'min="0"' : ''}`);
    modal('Итоги выписки',`<p class="subtitle">${esc(bankName(id))} · ${esc(period)}. Укажите итоги за полный календарный месяц. Выплаты вводятся положительной суммой.</p><div class="fields">${controlField('Входящий остаток','opening')}${controlField('Поступления','incoming')}${controlField('Выплаты','outgoing')}${controlField('Исходящий остаток','closing')}</div>`,
      values => api(kind,{...Object.fromEntries(values),account:id,month:period}));
  }
  if (kind === 'assign-account') modal('Указать счёт операции',selectField('Банковский счёт','account',accountOptions(),account),
    values => api(kind,{id:Number(arg),account:values.get('account')}));
  if (kind === 'unlink-transfer') modal('Разорвать связь перевода', '<p>Обе операции снова появятся в очереди распределения.</p>',
    () => api(kind,{id:Number(arg)}));
  if (kind === 'transfer') {
    const paired = transferMap();
    const allocated = new Set(data.allocations.map(row => row.operation));
    const available = data.operations.filter(op => op.account && !paired.has(op.id) && !allocated.has(op.id));
    const candidates = available.filter(op => op.amount > 0);
    const signed = op => [op.id,`${op.day} · ${bankName(op.account)} · ${rub(op.amount)} · ${op.description}`];
    const outgoing = available.filter(op => op.amount < 0 && candidates.some(other => other.amount === -op.amount && other.account !== op.account));
    if (!outgoing.length) return notify('Нет пары операций без распределения с одинаковой суммой на разных счетах.');
    const form = modal('Связать перевод',selectField('Списание','outgoing',outgoing.map(signed))
      + selectField('Поступление','incoming',[]),
      values => api(kind,Object.fromEntries(values)));
    const out = form.elements.outgoing;
    const update = () => {
      const selected = outgoing.find(op => op.id === Number(out.value));
      form.elements.incoming.innerHTML = idOptions(candidates.filter(op => op.amount === -selected.amount && op.account !== selected.account).map(signed));
    };
    out.addEventListener('change',update);
    update();
  }
  if (kind === 'import') {
    const sample = 'id;date;description;amount\nex-001;2026-06-26;Оплата лицензии;150000\nex-002;2026-06-27;Услуги дизайнера;-120000\n';
    const form = modal('Импорт выписки',`<p class="subtitle">Выберите CSV в UTF-8. Положительная сумма означает поступление, отрицательная — выплату.</p>${selectField('Банковский счёт','account',accountOptions(),account)}<label>CSV-файл<input type="file" name="statement" accept=".csv,text/csv" required></label><div><button class="button" type="button" id="sample">Скачать шаблон CSV</button></div>`,async (values) => {
      const file = values.get('statement');
      if (file.size > 1_800_000) throw new Error('Выберите CSV до 1,8 МБ.');
      const source = await file.text();
      const result = await api('import',{csv:source,account:values.get('account')});
      if (result.imported) {
        const importedMonth = source.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0].slice(0,7);
        if (importedMonth) period = importedMonth;
      }
      view = 'operations';
      project = '';
      account = values.get('account');
      operationFilter = 'all';
      return `Добавлено операций: ${result.imported}. Повторов: ${result.duplicates}.`;
    });
    form.querySelector('#sample').onclick = () => {
      const link = document.createElement('a');
      const url = URL.createObjectURL(new Blob(['\ufeff',sample],{type:'text/csv;charset=utf-8'}));
      link.href = url;
      link.download = 'qodex-statement.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    };
  }
  if (kind === 'balance') {
    const existing = data.balances.find(row => row.project === project);
    modal('Входящий остаток',`<p class="subtitle">${esc(project || 'Вся компания')}. Укажите остаток на начало дня до операций этой даты. Остаток проекта является управленческой оценкой.</p><div class="fields">${field('Дата начала','day','date',existing?.day || defaultDate,'required')}${amount(existing ? existing.amount / 100 : '')}</div>`, values => api(kind,{...Object.fromEntries(values),project}));
  }
  if (kind === 'request') save('Новая заявка',field('Назначение','title','text','','required maxlength="200"') + category(data.articles.slice(2)) + `<div class="fields">${field('Желаемая дата оплаты','day','date',defaultDate,'required')}${amount('','min="0.01"')}</div>`);
  if (kind === 'plan') save('Строка плана · ' + arg, `<small>Сценарий «${esc(scenario)}». Доходы и поступления вводятся со знаком плюс, расходы и выплаты — со знаком минус.</small>` + category(data.articles.filter(item => arg === 'БДДС' || !nonOperating.includes(item))) + `<div class="fields">${field('Месяц','month','month',period,'required')}${amount()}</div>`);
  if (kind === 'accrual') save('Ручное начисление',field('Описание','description','text','','required maxlength="200"') + category(data.articles.filter(item => !nonOperating.includes(item))) + `<div class="fields">${field('Месяц начисления','month','month',period,'required')}${amount()}</div>`);
  if (kind === 'freeze-budget') modal('Зафиксировать план',
    `<p class="subtitle">${esc(arg)} · ${esc(period)} · ${esc(scenario)}. Сохраняется план всех ООО и проектов.</p>`
    + field('Название версии','name','text','','maxlength="80" required'),async values => {
      const result = await api(kind,{month:period,basis:arg,scenario,name:values.get('name')});
      version = String(result.version);
    });
  if (kind === 'forecast') save('Ожидаемая операция',selectField('ООО','entity',legalOptions(),entity)
    + field('Дата','day','date',document.querySelector('#period').value + '-01','required')
    + field('Назначение','description','text','','required maxlength="200"')
    + amount() + '<small>Поступление со знаком плюс, выплата со знаком минус. Оплаты по заявкам уже учитываются. После отражения в выписке удалите ручную строку.</small>');
  if (kind === 'remove-forecast') modal('Удалить строку прогноза','<p>Операция будет исключена из ожидаемых движений.</p>',
    () => api(kind,{id:Number(arg)}));
  if (kind === 'payments') payments(data.requests.find(row => row.id === Number(arg)));
  if (kind === 'reschedule') {
    const item = data.requests.find(row => row.id === Number(arg));
    modal('Перенести оплату',field('Новая дата оплаты','day','date',dueDate(item),'required'),
      values => api(kind,{id:item.id,day:values.get('day')}));
  }
  if (kind === 'review') {
    const item = data.requests.find(row => row.id === Number(arg));
    modal('Решение по заявке',`<p class="subtitle">${esc(item.title)} · ${rub(item.amount)}</p>` + picker('Решение','status',['Согласована','Отклонена']),values => api('review',{id:item.id,status:values.get('status')}));
  }
}

document.addEventListener('click',event => {
  const control = event.target.closest('[data-action]');
  if (control) doAction(control.dataset.action);
});

content.addEventListener('change',event => {
  const {id,value} = event.target;
  if (id === 'period' && value) period = value;
  if (id === 'project') project = value;
  if (id === 'entity') {
    entity = value;
    account = '';
  }
  if (id === 'bankAccount') account = value;
  if (id === 'scenario') scenario = value;
  if (id === 'period' || id === 'scenario') version = '';
  if (id === 'version') version = value;
  if (id === 'operationFilter') operationFilter = value;
  if (['period','project','scenario','operationFilter','entity','bankAccount','version'].includes(id)) render();
});

api('state').then(state => {
  data = state;
  if (data.operations?.length) period = data.operations.map(item => item.day.slice(0,7)).sort().at(-1);
  render();
}).catch(error => {content.textContent = error.message;});
