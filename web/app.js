const content = document.querySelector('#content');
const dialog = document.querySelector('#dialog');
const nav = document.querySelector('#nav');
const RUB = new Intl.NumberFormat('ru-RU', {style:'currency',currency:'RUB',maximumFractionDigits:2,minimumFractionDigits:0});
const MONTHS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const tabs = [['overview','▦','Обзор'],['operations','⇄','Операции'],['cash','▤','БДДС'],['calendar','▧','Платёжный календарь'],['forecast','↗','Прогноз денег'],['profit','▥','БДР / P&L'],['distribution','∑','Распределение прибыли'],['funds','◈','Фонды'],['requests','✓','Заявки'],['accounts','▱','Счета'],['directories','▤','Справочники']];
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
let operationDirection = '';
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
const profitPaymentMap = () => new Map(data.profit_payments.map(row => [row.operation,row.decision]));

const clientName = id => data.clients.find(row => row.id === id)?.name || '';
const articlesFor = (direction,accrual = false) => Object.entries(data.articleDirections)
  .filter(([name,kind]) => (kind === direction || kind === 'both')
    && (!accrual || (!nonOperating.includes(name) && !data.cashStages.includes(name))))
  .map(([name]) => name);
const matchesDirection = op => !operationDirection || (op.amount > 0 ? 'income' : 'expense') === operationDirection;

function cashRows(includeTransfers = false) {
  const paid = profitPaymentMap();
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
    const lines = paid.has(op.id) ? [{amount:op.amount,project:'',article:'Дивиденды'}]
      : byOperation.get(op.id) || [{amount:op.amount,project:'',article}];
    return lines.map(row => ({...row, month:op.day.slice(0,7),day:op.day,account:op.account}));
  });
}

function profitRows() {
  const byId = new Map(data.operations.map(op => [op.id,op]));
  const matched = data.allocations.flatMap(row => {
    const op = byId.get(row.operation);
    const legal = bank(op?.account)?.entity;
    if (!row.accrual || nonOperating.includes(row.article) || !inEntity(legal)) return [];
    return [{...row,entity:legal,description:op.description,day:op.day,
      month:row.accrual,article:row.accrual_article || row.article}];
  });
  return [...matched, ...data.accruals.filter(row => inEntity(row.entity))];
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

const idOptions = (items, current) => items.map(([id,label]) => `<option value="${esc(id)}" ${String(id) === String(current) ? 'selected' : ''}>${esc(label)}</option>`).join('');
const legalOptions = () => data.entities.map((name,index) => [index + 1,name]);
const accountOptions = () => data.accounts.filter(item => inEntity(item.entity)).map(item => [item.id,bankName(item.id)]);
const selectField = (label,name,items,current,required = true) => `<label>${label}<select name="${name}" aria-label="${esc(label)}" ${required ? 'required' : ''}>${idOptions(items,current)}</select></label>`;

function filters(withScenario = false, operations = false, showAccount = true) {
  return `<div class="toolbar"><input type="month" aria-label="Отчётный месяц" id="period" value="${period}"><select id="project" aria-label="Проект"><option value="">Все проекты</option>${options(data.projects,project)}</select><select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select>${showAccount ? `<select id="bankAccount" aria-label="Банковский счёт"><option value="">Все счета</option>${idOptions(accountOptions(),account)}</select>` : ''}${withScenario ? `<select id="scenario" aria-label="Сценарий бюджета">${options(data.scenarios,scenario)}</select>` : ''}${operations ? `<select id="operationDirection" aria-label="Вид операции"><option value="">Поступления и расходы</option>${idOptions([['income','Поступления'],['expense','Расходы']],operationDirection)}</select><select id="operationFilter" aria-label="Статус распределения"><option value="all">Все операции</option><option value="pending" ${operationFilter === 'pending' ? 'selected' : ''}>Без распределения</option><option value="documents" ${operationFilter === 'documents' ? 'selected' : ''}>Ждём документы</option></select>` : ''}</div>`;
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
  const paid = profitPaymentMap();
  const byOperation = Map.groupBy(data.allocations, row => row.operation);
  const items = data.operations.filter(op => {
    if (!inScope(op.account) || (!compact && !matchesDirection(op))) return false;
    const lines = byOperation.get(op.id) || [];
    if (!compact && operationFilter === 'documents' && !op.document_pending) return false;
    if (!compact && operationFilter === 'pending' && (lines.length || paired.has(op.id) || paid.has(op.id))) return false;
    return op.day.startsWith(period) && (!project || (!paid.has(op.id) && lines.some(line => line.project === project)));
  }).sort((a,b) => b.day.localeCompare(a.day) || b.id-a.id);
  const rows = (compact ? items.slice(0,5) : items).map(op => {
    const lines = (byOperation.get(op.id) || []).filter(line => !project || project === line.project);
    const amount = project ? totals(lines).net : op.amount;
    const dividend = paid.get(op.id);
    const hint = [op.suggested_project,op.suggested_article].filter(Boolean).join(' · ');
    const note = op.document_pending ? 'Ждём документ' : !lines.length && !paired.has(op.id) && !dividend
      ? op.bank_hint === 'transfer' ? 'Возможный перевод или депозит'
      : [op.bank_hint === 'advance' ? 'Возможный аванс' : '',hint ? 'Подсказка: ' + hint : ''].filter(Boolean).join(' · ') : '';
    const category = dividend ? '<span class="pill">Дивиденды</span>' : paired.has(op.id) ? '<span class="pill">Внутренний перевод</span>'
      : lines.length ? esc([...new Set(lines.map(line => line.project))].join(', ')) : '<span class="pill pending">Без распределения</span>';
    const articles = [...new Set(lines.map(line => line.article))].join(', ');
    const payer = op.counterparty || op.payer_label;
    const client = clientName(op.client);
    const hintedClient = !client ? clientName(op.suggested_client) : '';
    const clientLabel = client ? 'Клиент: ' + client : hintedClient ? 'Подсказка: ' + hintedClient : '';
    const action = dividend ? button('Выплаты','profit-payments:' + dividend) : paired.has(op.id) ? button('Отвязать','unlink-transfer:' + op.id)
      : button(lines.length ? 'Открыть' : 'Распределить','allocate:' + op.id);
    return `<tr><td>${esc(op.day)}</td><td class="wrap">${esc(op.description)}<small>${esc([payer,bankName(op.account)].filter(Boolean).join(' · '))}</small>${clientLabel ? `<small>${esc(clientLabel)}</small>` : ''}</td>
      <td>${category}${articles && !dividend ? `<small>${esc(articles)}</small>` : ''}${note ? `<small>${esc(note)}</small>` : ''}</td>
      <td class="${sign(amount)}">${rub(amount)}</td><td>${action} ${!op.account ? button('Указать счёт','assign-account:' + op.id) : ''}</td></tr>`;
  });
  return table(compact ? 'Последние операции' : 'Банковские операции',['Дата','Назначение, плательщик и клиент','Проект и статья','Сумма',''],rows,'Операций за выбранный месяц нет.',compact ? button('Все операции','view:operations') : '');
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
  const structure = cash ? null : structuredPnl(budget,fact);
  const display = cash || pnlMode === 'articles' ? 'articles' : 'structure';
  const switchView = cash ? '' : button(display === 'structure' ? 'По статьям' : 'Структура P&L',
    'pnl-mode:' + (display === 'structure' ? 'articles' : 'structure')) + button('Настроить шаблон','pnl-edit');
  const actual = totals(fact), planned = totals(budget);
  const office = totals(fact.filter(row => row.project === 'Офис'));
  const trans = new Set([...budget,...fact].map(row => row.article));
  const rows = [...trans].map(article => {
    const actualAmount = totals(fact.filter(row => row.article === article)).net;
    const plannedAmount = totals(budget.filter(row => row.article === article)).net;
    return `<tr><td>${esc(article)}</td><td>${rub(plannedAmount)}</td><td>${rub(actualAmount)}</td><td class="${sign(actualAmount-plannedAmount)}">${rub(actualAmount-plannedAmount)}</td></tr>`;
  });
  const extras = cash ? '' : table('Ручные начисления',['Период','Проект','Описание','Сумма'],filterRows(data.accruals.filter(row => inEntity(row.entity))).map(item => `<tr><td>${esc(item.month)}</td><td>${esc(item.project)}</td><td class="wrap">${esc(item.description)}</td><td>${rub(item.amount)}</td></tr>`));
  return header(cash ? 'БДДС' : 'БДР / P&L',cash ? 'План и факт по датам платежей' : 'План и факт по месяцам начисления',planActions + (cash ? '' : button('+ Начисление','accrual') + button('Распределение прибыли','view:distribution') + switchView)) + filters(true,false,cash) + versionFilter
    + `<div class="metrics">${card(cash ? 'Чистый денежный поток' : 'Операционный результат',rub(actual.net),`План ${rub(planned.net)}`)}${card(cash ? 'Поступления' : 'Доходы',rub(actual.incoming),`План ${rub(planned.incoming)}`)}${card(cash ? 'Выплаты' : 'Расходы',rub(actual.outgoing),`План ${rub(planned.outgoing)}`)}${cash ? card('Отклонение потока',rub(actual.net-planned.net),'Факт минус план') : card('Маржа проектов',pnlPercent(structure.margin),`Офисные расходы · ${rub(office.outgoing)}`)}</div>`
    + (display === 'structure' ? structure.html : table('План-факт по статьям',['Статья','План','Факт','Отклонение'],rows))
    + (extras ? '<div class="calendar-gap"></div>' + extras : '');
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

function bankBalanceAt(cutoff, accounts, requireAssigned) {
  const opening = new Map(data.account_balances.filter(row => row.day <= cutoff).map(row => [row.account,row]));
  if (!accounts.length || accounts.some(item => !opening.has(item.id))
    || (requireAssigned && data.operations.some(op => !op.account && op.day <= cutoff))) return null;
  const byAccount = Map.groupBy(data.operations.filter(op => op.day <= cutoff),op => op.account);
  return accounts.reduce((sum,item) => {
    const start = opening.get(item.id);
    const operations = (byAccount.get(item.id) || []).filter(op => op.day >= start.day);
    return sum + start.amount + totals(operations).net;
  },0);
}

function forecast() {
  const today = new Date().toLocaleDateString('sv-SE');
  const horizon = period < today.slice(0,7) ? today.slice(0,7) : period;
  const scope = data.accounts.filter(item => inEntity(item.entity));
  const initial = bankBalanceAt(today,scope,!entity);
  let running = initial;
  const known = initial !== null;
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

function payments(item, profit = false) {
  const links = profit ? data.profit_payments : data.request_payments;
  const key = profit ? 'decision' : 'request';
  const existing = new Set(links.filter(row => row[key] === item.id).map(row => row.operation));
  const used = new Set([...data.request_payments,...data.profit_payments].map(row => row.operation));
  const paired = transferMap();
  const byOperation = Map.groupBy(data.allocations, row => row.operation);
  const candidates = data.operations.filter(op => {
    if (bank(op.account)?.entity !== item.entity || op.amount >= 0
      || -op.amount > outstanding(item) || used.has(op.id) || paired.has(op.id)) return false;
    const lines = byOperation.get(op.id) || [];
    return profit ? !op.document_pending && lines.every(row => row.article === 'Дивиденды')
      : lines.every(row => row.project === item.project && row.article === item.article);
  }).sort((a,b) => b.day.localeCompare(a.day));
  const heading = profit ? 'Выплаты собственникам' : 'Оплаты по заявке';
  const summary = `<p class="subtitle">${esc(profit ? item.note : item.title)} · оплачено ${rub(item.paid)} · остаток ${rub(outstanding(item))}</p>`;
  const describe = op => `${op.day} · ${bankName(op.account)} · ${rub(-op.amount)} · ${op.description}`;
  const history = existing.size ? `<ul class="payment-list">${data.operations.filter(op => existing.has(op.id))
    .sort((a,b) => a.day.localeCompare(b.day)).map(op =>
    `<li>${esc(describe(op))} <button class="button" type="button" data-detach="${op.id}">Отвязать</button></li>`).join('')}</ul>` : '';
  const instructions = profit
    ? 'В БДДС выплата отразится по банковской дате по статье «Дивиденды». Списание целиком относится к одному решению.'
    : 'Связь учитывает полную сумму списания. Если статья ещё не задана, она берётся из заявки. Месяц БДР задаётся в операции.';
  const action = profit ? 'profit-payment' : 'payment';
  const form = modal(heading,summary + history + (candidates.length
    ? selectField('Списание','operation',candidates.map(op => [op.id,describe(op)])) + `<small>${instructions}</small>`
    : '<p>Доступных списаний для привязки нет.</p>'),
  values => api('link-' + action,{[key]:item.id,operation:values.get('operation')}));
  const submit = form.querySelector('[type=submit]');
  submit.hidden = !candidates.length;
  submit.textContent = 'Привязать списание';
  form.addEventListener('click',event => {
    const control = event.target.closest('[data-detach]');
    if (!control) return;
    dialog.close();
    modal('Отвязать списание',`<p>${profit ? 'Остаток к выплате увеличится. Списание останется в выписке с его прежним разнесением.' : 'Сумма снова появится к оплате. Распределение банковской операции сохранится.'}</p>`,
      () => api('unlink-' + action,{operation:control.dataset.detach}));
  });
}

function entityPeriodFilters() {
  return `<div class="toolbar"><input type="month" aria-label="Отчётный месяц" id="period" value="${period}">
    <select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select></div>`;
}

function fundsReport() {
  const funds = data.funds.filter(item => inEntity(item.entity));
  const fundById = new Map(funds.map(item => [item.id,item]));
  const canceled = new Set(data.profit_decisions.filter(item => item.canceled).map(item => item.id));
  const entries = data.fund_entries.filter(item => fundById.has(item.fund) && item.day.slice(0,7) <= period);
  const active = entries.filter(item => !canceled.has(item.decision));
  const byFund = Map.groupBy(active,item => item.fund);
  const reserved = totals(active).net;
  const monthEnd = new Date(period + '-01T00:00:00Z');
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1,0);
  const scope = data.accounts.filter(item => inEntity(item.entity));
  const balance = bankBalanceAt(monthEnd.toISOString().slice(0,10),scope,!entity);
  const available = balance === null ? null : balance - reserved;
  const rows = funds.map(item => {
    const moves = byFund.get(item.id) || [];
    const opening = totals(moves.filter(row => row.day.slice(0,7) < period)).net;
    const current = totals(moves.filter(row => row.day.slice(0,7) === period));
    return `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(entityName(item.entity))}</td><td>${rub(opening)}</td>
      <td>${rub(current.incoming)}</td><td>${rub(current.outgoing)}</td><td><strong>${rub(opening+current.net)}</strong></td>
      <td>${button('Движение','fund-entry:' + item.id)}</td></tr>`;
  });
  const journal = entries.filter(item => item.day.startsWith(period)).sort((a,b) => b.day.localeCompare(a.day) || b.id-a.id).map(item => {
    const label = canceled.has(item.decision) ? 'Решение отменено' : item.decision ? 'Из прибыли' : item.amount > 0 ? 'Пополнение' : 'Высвобождение';
    const fund = fundById.get(item.fund);
    return `<tr><td>${esc(item.day)}</td><td>${esc(fund.name)}<small>${esc(entityName(fund.entity))}</small></td><td>${label}</td>
      <td class="wrap">${esc(item.note)}<small>${esc(item.actor)}</small></td><td class="${sign(item.amount)}">${rub(item.amount)}</td></tr>`;
  });
  return header('Фонды','Резервы денежных средств по ООО',button('+ Фонд','fund',true)) + entityPeriodFilters()
    + `<div class="metrics">${card('В фондах',rub(reserved),'Остаток резервов к концу месяца')}
      ${card('Деньги на счетах',balance === null ? '—' : rub(balance),balance === null ? 'Укажите входящие остатки по счетам' : 'По данным банковских операций')}
      ${card('Свободно после резервов',available === null ? '—' : rub(available),available !== null && available < 0 ? 'Резервы выше остатка на счетах' : 'Остаток на счетах за вычетом фондов')}</div>`
    + table('Остатки фондов',['Фонд','ООО','На начало','Пополнения','Высвобождено','На конец',''],rows,'Создайте фонд, чтобы начать вести резерв.')
    + '<div class="calendar-gap"></div>' + table('Журнал фондов',['Дата','Фонд','Движение','Основание','Сумма'],journal);
}

function distributionReport() {
  const fact = profitRows().filter(row => row.month === period);
  const byProject = Map.groupBy(fact,row => row.project);
  const allocations = data.office_contributions.filter(row => row.month === period && inEntity(row.entity));
  const officeReceived = totals(allocations).incoming;
  const projectTotal = totals(fact.filter(row => row.project !== 'Офис'));
  const office = totals(byProject.get('Офис') || []);
  const result = projectTotal.net + office.net;
  const decisions = data.profit_decisions.filter(row => row.month === period && inEntity(row.entity));
  const active = decisions.filter(row => !row.canceled);
  const funds = totals(active.filter(row => row.fund)).incoming;
  const ownerDecisions = active.filter(row => !row.fund);
  const owners = totals(ownerDecisions).incoming;
  const ownerBalance = ownerDecisions.reduce((total,row) => total + outstanding(row),0);
  const remaining = result - funds - owners;
  const pnlRow = (name,amounts,transfer,summary = false) => `<tr class="${summary ? 'summary-row' : ''}">
    <td><strong>${esc(name)}</strong></td><td>${rub(amounts.incoming)}</td><td>${rub(amounts.outgoing)}</td>
    <td class="${sign(amounts.net)}">${rub(amounts.net)}</td><td class="${sign(transfer)}">${rub(transfer)}</td>
    <td class="${sign(amounts.net+transfer)}"><strong>${rub(amounts.net+transfer)}</strong></td></tr>`;
  const rows = data.projects.filter(name => name !== 'Офис').map(name => {
    const amount = totals(allocations.filter(row => row.project === name)).incoming;
    return pnlRow(name,totals(byProject.get(name) || []),-amount);
  });
  rows.push(pnlRow('Офис',office,officeReceived),pnlRow('Итого',totals(fact),0,true));
  const decisionRows = [...decisions].sort((a,b) => b.day.localeCompare(a.day) || b.id-a.id).map(item => {
    const destination = item.fund ? data.funds.find(fund => fund.id === item.fund)?.name : 'Собственникам';
    const payable = !item.fund && !item.canceled;
    const balance = outstanding(item);
    const status = item.canceled ? 'Отменено' : item.fund ? 'Направлено в фонд' : !balance ? 'Выплачено'
      : item.paid ? 'Частично выплачено' : 'К выплате';
    const actions = (payable ? button('Выплаты','profit-payments:' + item.id) : '')
      + (!item.canceled && !item.paid ? ' ' + button('Отменить','cancel-profit-decision:' + item.id) : '');
    return `<tr><td>${esc(item.day)}</td><td>${esc(entityName(item.entity))}</td><td>${esc(destination)}</td>
      <td class="wrap">${esc(item.note)}<small>${esc(item.actor)}</small></td><td>${rub(item.amount)}</td>
      <td>${payable ? rub(item.paid) : '—'}</td><td>${payable ? rub(balance) : '—'}</td>
      <td><span class="pill ${payable && balance ? 'pending' : ''}">${status}</span></td><td>${actions}</td></tr>`;
  });
  return header('Распределение прибыли','Результат по начислениям, вклад в офис и решения по прибыли',
    button('Вклад в офис','office-contribution') + button('+ Решение','profit-decision',true)) + entityPeriodFilters()
    + `<div class="metrics">${card('Результат проектов',rub(projectTotal.net),'До вклада в офис')}
      ${card('Расходы офиса',rub(office.outgoing),`Вклад проектов ${rub(officeReceived)}`)}
      ${card('Результат после офиса',rub(result),'По начислениям БДР')}
      ${card('Остаток после решений',rub(remaining),remaining < 0 && funds + owners > 0 ? 'Решения превышают результат месяца' : `В фонды ${rub(funds)} · Собственникам ${rub(owners)}`)}</div>`
    + table('Проекты и офис',['Центр','Доходы','Расходы','Результат до вклада','Внутренний вклад','Результат после вклада'],rows)
    + '<div class="calendar-gap"></div>' + table('Решения по прибыли',['Дата решения','ООО','Направление','Основание','Сумма','Выплачено','Остаток','Статус',''],
      decisionRows,'За выбранный период решений нет.',`<small>Собственникам осталось выплатить ${rub(ownerBalance)}</small>`);
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
  const statements = data.bank_statements.filter(item => inScope(item.account)).sort((a,b) => b.end.localeCompare(a.end));
  const imports = statements.map(item => {
    const ops = data.operations.filter(op => op.account === item.account && op.day >= item.start && op.day <= item.end);
    const check = totals(ops);
    const start = data.account_balances.find(row => row.account === item.account && row.day <= item.start);
    const opening = start ? start.amount + totals(data.operations.filter(op =>
      op.account === item.account && op.day >= start.day && op.day < item.start)).net : null;
    const status = check.incoming !== item.incoming || check.outgoing !== item.outgoing
      || (opening !== null && opening !== item.opening) ? 'Есть расхождения'
      : opening === null ? 'Обороты совпали' : 'Сверено с выпиской';
    return `<tr><td>${esc(bankName(item.account))}</td><td>${esc(item.start)} — ${esc(item.end)}</td>
      <td>${rub(item.opening)}</td><td>${rub(item.incoming)}</td><td>${rub(item.outgoing)}</td><td>${rub(item.closing)}</td>
      <td><span class="pill ${status === 'Есть расхождения' ? 'pending' : ''}">${status}</span></td></tr>`;
  });
  return header('Банковские счета','Остатки, обороты и сверка с выписками',button('+ Счёт','account',true))
    + `<div class="toolbar"><input type="month" aria-label="Отчётный месяц" id="period" value="${period}">
       <select id="entity" aria-label="Юридическое лицо"><option value="">Все ООО</option>${idOptions(legalOptions(),entity)}</select>
       <select id="bankAccount" aria-label="Банковский счёт"><option value="">Все счета</option>${idOptions(accountOptions(),account)}</select></div>`
    + table('Сверка за месяц',['Счёт',...Object.values(titles),'Статус',''],rows,'В выбранном разрезе счетов нет.')
    + (imports.length ? '<div class="calendar-gap"></div>'
      + table('Загруженные выписки Точки',['Счёт','Период',...Object.values(titles),'Статус'],imports) : '');
}

function directories() {
  const names = data.projects.map(name => `<tr><td>${esc(name)}</td></tr>`);
  const directions = {income:'Поступления',expense:'Расходы',both:'Оба направления'};
  const articles = Object.entries(data.articleDirections).sort(([a],[b]) => a.localeCompare(b,'ru')).map(([name,direction]) =>
    `<tr><td>${esc(name)}${data.cashStages.includes(name) ? '<small>Этап оплаты в БДДС</small>' : ''}</td><td>${directions[direction]}</td></tr>`);
  const payers = Map.groupBy(data.client_payers,row => row.client);
  const receipts = Map.groupBy(data.operations.filter(op => op.amount > 0 && op.client),op => op.client);
  const clients = data.clients.map(item => {
    const linkedPayers = new Set([...(payers.get(item.id) || []).map(row => row.payer),
      ...(receipts.get(item.id) || []).map(row => row.counterparty || row.payer_label).filter(Boolean)]);
    return `<tr><td>${esc(item.name)}</td><td class="wrap">${linkedPayers.size ? esc([...linkedPayers].join(', ')) : '—'}</td></tr>`;
  });
  return header('Справочники','Проекты, статьи и основные клиенты')
    + '<div class="directory-grid">'
    + table('Проекты',['Название'],names,'Проектов пока нет.',button('+ Проект','project',true))
    + table('Клиенты',['Основной клиент','Плательщики из поступлений'],clients,'Добавьте клиента здесь или в карточке поступления.',button('+ Клиент','client',true))
    + '</div><div class="calendar-gap"></div>'
    + table('Статьи',['Название','Направление'],articles,'Статей пока нет.',button('+ Статья','article',true));
}

function render() {
  if (!finance()) view = 'requests';
  if (view === 'profit' || view === 'pnl-template' || view === 'calendar') account = '';
  nav.innerHTML = '<p class="nav-label">РАЗДЕЛЫ</p>' + tabs.filter(([key]) => finance() || key === 'requests').map(([key,icon,text]) => `<button data-action="view:${key}" class="${view === key || (key === 'profit' && view === 'pnl-template') ? 'nav-active' : ''}" ${view === key || (key === 'profit' && view === 'pnl-template') ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${text}</button>`).join('');
  document.querySelector('#account').innerHTML = `<span class="avatar" aria-hidden="true">${esc(data.user[0])}</span><div>${esc(data.user)}<small>${finance() ? 'Финансист' : 'Сотрудник'}</small></div>`;
  if (view === 'overview') content.innerHTML = overview();
  if (view === 'operations') {
    const count = bankSuggestions().length;
    const suggestion = count ? button(`Подсказки (${count})`,'bank-suggestions') : '';
    content.innerHTML = header('Операции','Банковская выписка и распределение по проектам',
      suggestion + button('Связать перевод','transfer') + button('↑ Импорт выписки','import',true)) + filters(false,true) + operationTable();
  }
  if (view === 'cash') content.innerHTML = report('БДДС');
  if (view === 'profit') content.innerHTML = report('БДР');
  if (view === 'pnl-template') content.innerHTML = pnlEditor();
  if (view === 'requests') content.innerHTML = requests();
  if (view === 'calendar') content.innerHTML = calendar();
  if (view === 'forecast') content.innerHTML = forecast();
  if (view === 'accounts') content.innerHTML = accountReport();
  if (view === 'funds') content.innerHTML = fundsReport();
  if (view === 'distribution') content.innerHTML = distributionReport();
  if (view === 'directories') content.innerHTML = directories();
}

const field = (label, name, type, value = '', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const picker = (label, name, items, value) => `<label>${label}<select name="${name}">${options(items,value)}</select></label>`;

function modal(title, fields, handler, onSuccess = null) {
  dialog.innerHTML = `<form><div class="row"><h2>${title}</h2><button class="button" type="button" data-close aria-label="Закрыть">×</button></div>${fields}<div class="error" role="alert"></div><div><button class="button primary" type="submit">Сохранить</button></div></form>`;
  const form = dialog.querySelector('form');
  form.querySelector('[data-close]').onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const note = await handler(new FormData(form),form,event.submitter);
      if (onSuccess) {
        dialog.close();
        onSuccess(note);
      } else {
        data = await api('state');
        dialog.close();
        render();
        notify(typeof note === 'string' ? note : 'Изменения сохранены.');
      }
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
  const fromBank = op.ref.startsWith('tochka:');
  const incoming = op.amount > 0;
  const direction = incoming ? 'income' : 'expense';
  const articleLabel = incoming ? 'Статья поступления' : 'Статья расхода';
  const articles = [...new Set([...articlesFor(direction),...previous.map(row => row.article)])];
  const cashArticle = (selected) => selectField(articleLabel,'article',
    [['','Выберите статью'],...articles.map(name => [name,name])],selected);
  const profitArticle = (selected) => selectField('Статья БДР','accrualArticle',
    [['','По умолчанию'],...articlesFor(direction,true).map(name => [name,name])],selected,false);
  const makeRow = (line = {}) => `<div class="split ${incoming ? 'receipt-split' : ''}">
    ${selectField('Проект','project',[['','Выберите проект'],...data.projects.map(name => [name,name])],line.project ?? '')}
    ${cashArticle(line.article)}${field('Сумма, ₽','amount','number',line.amount == null ? '' : line.amount / 100,'step="0.01" required')}
    ${field('Месяц БДР','accrual','month',line.accrual || '')}${incoming ? profitArticle(line.accrual_article) : ''}
    <button type="button" class="button remove" aria-label="Удалить строку">×</button></div>`;
  const initial = {amount:op.amount,project:op.suggested_project ?? project,
    article:op.suggested_article ?? (fromBank ? '' : incoming ? '' : 'Разработка'),
    accrual:fromBank || incoming || op.document_pending ? '' : op.day.slice(0,7)};
  const pending = op.document_pending || (op.bank_hint === 'advance' && !previous.length);
  const checks = `<label class="finance-option"><input type="checkbox" name="documentPending" ${pending ? 'checked' : ''}> Ждём акт или другой документ</label>`
    + (op.has_bank_payer && op.bank_hint !== 'transfer'
      ? '<label class="finance-option"><input type="checkbox" name="remember"> Запомнить проект и статью для этого плательщика по счёту</label>' : '');
  const clientFields = incoming ? `<div class="fields">
    ${op.counterparty ? `<div class="payer-field"><small>Плательщик из выписки</small><strong>${esc(op.counterparty)}</strong></div>`
      : field('Плательщик','payer','text',op.payer_label || '','maxlength="200"')}
    ${selectField('Основной клиент','client',
      [['','Без клиента'],...data.clients.map(item => [item.id,item.name]),['new','+ Новый клиент']],op.client ?? op.suggested_client ?? '',false)}
    </div><div id="new-client" hidden>${field('Название клиента','newClient','text','','maxlength="100"')}</div>`
    + (op.has_bank_payer ? '<label class="finance-option"><input type="checkbox" name="rememberClient"> Подсказывать этого клиента для будущих платежей данного плательщика</label>' : '')
    : '';
  const help = incoming
    ? 'Месяц БДР укажите, когда выручка заработана. Для этапов оплаты статья БДР по умолчанию — «Выручка по проекту».'
    : 'Пустой месяц БДР оставляет строку только в БДДС. Для уже отражённого ручного начисления оставьте месяц пустым.';
  const form = modal(incoming ? 'Распределение поступления' : 'Распределение операции',
    `<p class="subtitle">${esc([incoming ? '' : op.counterparty,op.description,rub(op.amount),op.day].filter(Boolean).join(' · '))}</p>${clientFields}
    <small>${help}</small><div id="lines">${(previous.length ? previous : [initial]).map(makeRow).join('')}</div>
    <div class="row"><button class="button" type="button" id="add-line">+ Доля проекта</button><strong id="remaining"></strong></div>${checks}`,
  async (values,form) => {
    const lines = [...form.querySelectorAll('.split')].map(row => Object.fromEntries([...row.querySelectorAll('input,select')].map(input => [input.name,input.value])));
    const extra = incoming ? {
      client:values.get('client') === 'new' ? '' : values.get('client'),
      newClient:values.get('client') === 'new' ? values.get('newClient') : '',
      payer:values.get('payer'),rememberClient:values.has('rememberClient')
    } : {};
    await api('allocate',{id:op.id,lines,documentPending:values.has('documentPending'),remember:values.has('remember'),...extra});
  });
  const update = () => {
    const assigned = [...form.querySelectorAll('[name=amount]')].reduce((total,input) => total + Math.round(Number(input.value) * 100),0);
    form.querySelector('#remaining').textContent = 'Осталось ' + rub(op.amount - assigned);
    if (incoming) {
      form.querySelectorAll('.split').forEach(row => {
        row.querySelector('[name=accrualArticle]').disabled = !row.querySelector('[name=accrual]').value;
      });
      const showName = form.elements.client.value === 'new';
      form.querySelector('#new-client').hidden = !showName;
      form.elements.newClient.required = showName;
      if (op.has_bank_payer) {
        form.elements.rememberClient.disabled = !form.elements.client.value;
      }
    }
  };
  form.querySelector('#add-line').onclick = () => {
    form.querySelector('#lines').insertAdjacentHTML('beforeend',makeRow({
      accrual:fromBank || incoming || form.elements.documentPending.checked ? '' : op.day.slice(0,7)
    }));
    update();
  };
  form.addEventListener('click', event => {
    if (event.target.matches('.remove')) {
      event.target.closest('.split').remove();
      update();
    }
  });
  form.addEventListener('input',update);
  form.addEventListener('change',update);
  update();
}

function showStatementResult(result) {
  if (result.new || result.imported) period = (result.end || result.month).slice(0,7);
  view = 'operations';
  project = '';
  account = String(result.account);
  if (result.entity) entity = String(result.entity);
  operationFilter = 'all';
  operationDirection = '';
  return `Добавлено операций: ${result.new ?? result.imported}. Повторов: ${result.duplicates}.`;
}

function statementImport() {
  const sample = 'id;date;description;amount\nex-001;2026-06-26;Оплата лицензии;150000\nex-002;2026-06-27;Услуги дизайнера;-120000\n';
  const choices = data.accounts.map(item => [item.id,bankName(item.id)]);
  const newAccounts = legalOptions().map(([id,name]) => ['new:' + id,'Счёт Точки · ' + name + ' (по номеру из файла)']);
  const form = modal('Импорт банковской выписки',
    '<p class="subtitle">Загрузите XLSX из Точки напрямую. Для других выписок можно использовать CSV по шаблону.</p>'
    + selectField('Банковский счёт','account',[...newAccounts,...choices],account || 'new:' + (entity || '1'))
    + '<label>Файл выписки<input type="file" name="statement" accept=".xlsx,.csv,text/csv" required></label>'
    + '<div><button class="button" type="button" id="sample">Скачать шаблон CSV</button></div>',
  async values => {
    const file = values.get('statement');
    const selectedAccount = values.get('account');
    if (/\.csv$/i.test(file.name)) {
      if (selectedAccount.startsWith('new:')) throw new Error('Для CSV выберите существующий счёт.');
      if (file.size > 1_800_000) throw new Error('Выберите CSV до 1,8 МБ.');
      const csv = await file.text();
      const result = await api('import',{csv,account:selectedAccount});
      data = await api('state');
      return {message:showStatementResult({...result,account:selectedAccount,month:csv.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || period})};
    }
    if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > 1_000_000) {
      throw new Error('Выберите заполненный XLSX Точки до 1 МБ.');
    }
    const workbook = await new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Не удалось открыть файл.'));
      reader.readAsDataURL(file);
    });
    const payload = {workbook,account:selectedAccount};
    return {payload,preview:await api('preview-tochka',payload)};
  }, ({payload,preview,message}) => {
    if (message) {
      render();
      notify(message);
      return;
    }
    const {accountTail,entity:legal,start,end,opening,incoming,outgoing,closing,other} = preview;
    const totals = [
      ['На начало',opening],['Поступления',incoming],['Списания',outgoing],['На конец',closing]
    ];
    const confirmation = modal('Предпросмотр выписки Точки',
      `<p><strong>${esc(entityName(legal))} · счёт ••••${esc(accountTail)}</strong><br>${esc(start)} — ${esc(end)}</p>
       <p>Новых операций: <strong>${preview.new}</strong> · повторов: ${preview.duplicates}</p>
       <dl class="statement-totals">${totals.map(([label,value]) => `<div><dt>${label}</dt><dd>${rub(value)}</dd></div>`).join('')}</dl>
       <small>Суммы операций сходятся с итогами файла. Проекты и статьи можно подтвердить после загрузки.</small>`
      + (other ? '<p class="error">На выбранном счёте уже есть операции из других источников. При пересечении периодов выберите счёт Точки по номеру из файла или предварительно сверьте записи.</p>' : ''),
      async () => showStatementResult(await api('import-tochka',payload)));
    confirmation.querySelector('[type=submit]').textContent = 'Загрузить операции';
  });
  form.querySelector('[type=submit]').textContent = 'Продолжить';
  form.querySelector('#sample').onclick = () => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob(['\ufeff',sample],{type:'text/csv;charset=utf-8'}));
    link.href = url;
    link.download = 'qodex-statement.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };
}

function bankSuggestions() {
  const allocated = new Set(data.allocations.map(item => item.operation));
  const paired = transferMap();
  const paid = profitPaymentMap();
  return data.operations.filter(op => inScope(op.account) && op.day.startsWith(period) && matchesDirection(op)
    && (!project || project === op.suggested_project) && op.suggested_project && op.suggested_article
    && !allocated.has(op.id) && !paired.has(op.id) && !paid.has(op.id));
}

function confirmSuggestions() {
  const candidates = bankSuggestions();
  if (!candidates.length) return notify('В выбранном месяце нет готовых подсказок.');
  const groups = Map.groupBy(candidates, op => `${op.suggested_project} · ${op.suggested_article}`);
  const summary = [...groups].map(([label,ops]) =>
    `<tr><td>${esc(label)}</td><td>${ops.length}</td><td>${rub(totals(ops).net)}</td></tr>`);
  const form = modal('Подтвердить подсказки',table('Разнесение за месяц',['Проект и статья','Операций','Чистый поток'],summary)
    + '<small>Операции получат аналитику БДДС. Месяц БДР укажите отдельно по документам.</small>',
  async () => {
    const result = await api('apply-bank-suggestions',{ids:candidates.map(op => op.id)});
    return `Разнесено операций: ${result.applied}.`;
  });
  form.querySelector('[type=submit]').textContent = 'Подтвердить разнесение';
}

function budgetEntry(kind,basis) {
  const accrual = kind === 'accrual';
  const isPnl = accrual || basis === 'БДР';
  const directions = isPnl ? [['income','Доход'],['expense','Расход']] : [['income','Поступление'],['expense','Выплата']];
  const form = modal(accrual ? 'Ручное начисление' : 'Строка плана · ' + basis,
    (accrual ? field('Описание','description','text','','required maxlength="200"') : `<small>Сценарий «${esc(scenario)}»</small>`)
    + selectField('ООО','entity',legalOptions(),entity)
    + `<div class="fields">${selectField('Вид строки','direction',directions)}${picker('Проект','project',data.projects,project)}
    ${selectField('Статья','article',[])}${field('Месяц','month','month',period,'required')}
    ${field('Сумма, ₽','amount','number','','step="0.01" min="0.01" required')}</div>`,
  values => api(kind,{
    ...Object.fromEntries(values),basis,scenario,
    amount:(values.get('direction') === 'expense' ? '-' : '') + values.get('amount')
  }));
  const update = () => {
    form.elements.article.innerHTML = idOptions(articlesFor(form.elements.direction.value,isPnl).map(name => [name,name]));
  };
  form.elements.direction.onchange = update;
  update();
}

function doAction(action) {
  const [kind,arg] = action.split(':');
  if (handlePnlAction(kind,arg)) return;
  if (kind === 'view') {
    view = arg;
    version = '';
    render();
    return;
  }
  const defaultDate = period + '-01';
  const amount = (value = '',extra = '') => field('Сумма, ₽','amount','number',value,`step="0.01" required ${extra}`);
  const category = articles => selectField('ООО','entity',legalOptions(),entity) + `<div class="fields">${picker('Проект','project',data.projects,project)}${picker('Статья','article',articles)}</div>`;
  const save = (title,fields) => modal(title,fields,values => api(kind,{...Object.fromEntries(values),basis:arg,scenario}));
  if (kind === 'project') save('Новый проект',field('Название проекта','name','text','','maxlength="100" required'));
  if (kind === 'article') save('Новая статья',field('Название статьи','name','text','','maxlength="100" required')
    + selectField('Направление','direction',[['income','Поступления'],['expense','Расходы']]));
  if (kind === 'client') save('Новый клиент',field('Название клиента','name','text','','maxlength="100" required'));
  if (kind === 'allocate') allocation(data.operations.find(op => op.id === Number(arg)));
  if (kind === 'fund') save('Новый фонд',selectField('ООО','entity',legalOptions(),entity)
    + field('Название фонда','name','text','','maxlength="80" required'));
  if (kind === 'fund-entry') {
    const fund = data.funds.find(item => item.id === Number(arg));
    modal('Движение в фонде',`<p>${esc(entityName(fund.entity))} · ${esc(fund.name)}</p>`
      + selectField('Движение','direction',[['reserve','Пополнение'],['release','Высвобождение']])
      + field('Дата','day','date',defaultDate,'required') + amount('','min="0.01"')
      + field('Основание','note','text','','maxlength="200" required')
      + '<small>Запись меняет резерв. Платежи по-прежнему отражаются в банковских операциях.</small>',
      values => api(kind,{...Object.fromEntries(values),fund:fund.id}));
  }
  if (kind === 'office-contribution') {
    const form = modal('Вклад проекта в офис',selectField('ООО','entity',legalOptions(),entity)
      + picker('Проект','project',data.projects.filter(name => name !== 'Офис'),project)
      + amount('','min="0"') + '<small>Вклад относится к выбранному месяцу. Ноль снимает распределение. Результат ООО и БДДС сохраняются.</small>',
      values => api(kind,{...Object.fromEntries(values),month:period}));
    const update = () => {
      const now = data.office_contributions.find(row => row.entity === Number(form.elements.entity.value)
        && row.month === period && row.project === form.elements.project.value);
      form.elements.amount.value = now ? now.amount / 100 : '';
    };
    form.elements.entity.onchange = update;
    form.elements.project.onchange = update;
    update();
  }
  if (kind === 'profit-decision') {
    const form = modal('Решение по прибыли',selectField('ООО','entity',legalOptions(),entity)
      + selectField('Направление','fund',[])
      + field('Дата решения','day','date',new Date().toLocaleDateString('sv-SE'),'required')
      + amount('','min="0.01"') + field('Основание','note','text','','maxlength="200" required')
      + `<small>Результат за ${esc(period)}. Запись в фонд сразу увеличит резерв. Оплату собственникам отразите по выписке.</small>`,
      values => api(kind,{...Object.fromEntries(values),fund:values.get('fund') === 'owners' ? null : values.get('fund'),month:period}));
    const update = () => {
      const choices = data.funds.filter(item => item.entity === Number(form.elements.entity.value));
      form.elements.fund.innerHTML = idOptions([['owners','Собственникам'],...choices.map(item => [item.id,item.name])]);
    };
    form.elements.entity.onchange = update;
    update();
  }
  if (kind === 'cancel-profit-decision') modal('Отменить решение',
    '<p>Отмена исключит сумму из распределения прибыли. Для фонда остаток пересчитается с даты решения.</p>',
    () => api(kind,{id:Number(arg)}));
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
    const paid = profitPaymentMap();
    const available = data.operations.filter(op => op.account && !paired.has(op.id) && !allocated.has(op.id) && !paid.has(op.id));
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
  if (kind === 'import') statementImport();
  if (kind === 'bank-suggestions') confirmSuggestions();
  if (kind === 'balance') {
    const existing = data.balances.find(row => row.project === project);
    modal('Входящий остаток',`<p class="subtitle">${esc(project || 'Вся компания')}. Укажите остаток на начало дня до операций этой даты. Остаток проекта является управленческой оценкой.</p><div class="fields">${field('Дата начала','day','date',existing?.day || defaultDate,'required')}${amount(existing ? existing.amount / 100 : '')}</div>`, values => api(kind,{...Object.fromEntries(values),project}));
  }
  if (kind === 'request') save('Новая заявка',field('Назначение','title','text','','required maxlength="200"') + category(articlesFor('expense')) + `<div class="fields">${field('Желаемая дата оплаты','day','date',defaultDate,'required')}${amount('','min="0.01"')}</div>`);
  if (kind === 'plan' || kind === 'accrual') budgetEntry(kind,arg);
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
  if (kind === 'profit-payments') payments(data.profit_decisions.find(row => row.id === Number(arg)),true);
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
  if (id === 'operationDirection') operationDirection = value;
  if (['period','project','scenario','operationFilter','operationDirection','entity','bankAccount','version'].includes(id)) render();
});

api('state').then(state => {
  data = state;
  if (data.operations?.length) period = data.operations.map(item => item.day.slice(0,7)).sort().at(-1);
  render();
}).catch(error => {content.textContent = error.message;});
