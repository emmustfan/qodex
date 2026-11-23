const scheduleForOperation = operation => data.accrual_schedule_payments.find(row => row.operation === operation)?.schedule;

function scheduleReport() {
  const schedules = data.accrual_schedules.filter(row => inEntity(row.entity) && (!project || row.project === project));
  const byId = new Map(schedules.map(item => [item.id,item]));
  const confirmed = new Set(data.accruals.map(row => row.schedule_month));
  const bySchedule = Map.groupBy(data.schedule_months,row => row.schedule);
  const links = Map.groupBy(data.accrual_schedule_payments,row => row.schedule);
  const operations = new Map(data.operations.map(op => [op.id,op]));
  const current = data.schedule_months.filter(row => byId.has(row.schedule) && row.month === period);
  const monthRows = current.map(row => {
    const item = byId.get(row.schedule);
    return `<tr><td class="wrap">${esc(item.title)}<small>${esc(item.project)} · ${esc(entityName(item.entity))}</small></td>
      <td>${esc(item.article)}</td><td class="${sign(row.amount)}">${rub(row.amount)}</td>
      <td>${scheduleMonthStatus(confirmed.has(row.id))}</td><td>${scheduleMonthAction(row,confirmed.has(row.id))}</td></tr>`;
  });
  const contractRows = schedules.map(item => {
    const months = bySchedule.get(item.id);
    const approved = totals(months.filter(row => confirmed.has(row.id))).net;
    const paid = totals((links.get(item.id) || []).map(row => operations.get(row.operation))).net;
    return `<tr><td class="wrap"><strong>${esc(item.title)}</strong><small>${esc(item.project)} · ${esc(entityName(item.entity))}</small>
      <small>${esc(months[0].month)} — ${esc(months.at(-1).month)}</small></td>
      <td>${esc(item.article)}</td><td>${rub(item.amount)}</td><td>${rub(approved)}</td><td>${rub(Math.abs(paid))}</td>
      <td>${button('Месяцы','schedule-months:' + item.id)} ${button('Оплаты','schedule-payments:' + item.id)}
      ${months.every(row => !confirmed.has(row.id)) && !paid ? button('Удалить черновик','schedule-remove:' + item.id) : ''}</td></tr>`;
  });
  return header('Графики начислений','Выручка и расходы по договорам с подтверждением месяца',
    button('+ График','schedule-new',true)) + filters(false,false,false)
    + table('Строки за выбранный месяц',['Договор','Статья БДР','Сумма','Статус',''],monthRows)
    + '<div class="calendar-gap"></div>'
    + table('Все графики',['Договор и период','Статья БДР','По графику','Начислено','Из выписки',''],contractRows,'Добавьте первый график.');
}

function scheduleMonthStatus(confirmed) {
  return `<span class="pill ${confirmed ? '' : 'pending'}">${confirmed ? 'Начислено' : 'К подтверждению'}</span>`;
}

function scheduleMonthAction(row,confirmed) {
  return confirmed ? button('Снять подтверждение','schedule-undo:' + row.id)
    : button('Подтвердить','schedule-confirm:' + row.id);
}

function scheduleMonths(item) {
  const confirmed = new Set(data.accruals.map(row => row.schedule_month));
  const rows = data.schedule_months.filter(row => row.schedule === item.id).map(row =>
    `<tr><td>${esc(row.month)}</td><td class="${sign(row.amount)}">${rub(row.amount)}</td>
      <td>${scheduleMonthStatus(confirmed.has(row.id))}</td><td>${scheduleMonthAction(row,confirmed.has(row.id))}</td></tr>`);
  const form = modal('Месяцы графика',`<p>${esc(item.title)}</p>` + table('График',['Месяц','Сумма','Статус',''],rows),() => {});
  form.querySelector('[type=submit]').hidden = true;
}

function schedulePayments(item) {
  const linked = new Set(data.accrual_schedule_payments.filter(row => row.schedule === item.id).map(row => row.operation));
  const used = new Set(data.accrual_schedule_payments.map(row => row.operation));
  const existing = data.operations.filter(op => linked.has(op.id)).sort((a,b) => a.day.localeCompare(b.day));
  const paid = Math.abs(totals(existing).net);
  const outstandingAmount = Math.abs(item.amount) - paid;
  const paired = transferMap();
  const dividends = profitPaymentMap();
  const byOperation = Map.groupBy(data.allocations,row => row.operation);
  const available = data.operations.filter(op => {
    const allocation = byOperation.get(op.id) || [];
    return op.amount * item.amount > 0 && bank(op.account)?.entity === item.entity && Math.abs(op.amount) <= outstandingAmount
      && !paired.has(op.id) && !dividends.has(op.id) && !used.has(op.id)
      && allocation.length && allocation.every(row => row.project === item.project && !row.accrual && !nonOperating.includes(row.article));
  }).sort((a,b) => b.day.localeCompare(a.day));
  const describe = op => `${op.day} · ${bankName(op.account)} · ${rub(op.amount)} · ${op.description}`;
  const history = existing.length ? `<ul class="payment-list">${existing.map(op =>
    `<li>${esc(describe(op))} <button class="button" type="button" data-action="schedule-unlink:${op.id}">Отвязать</button></li>`).join('')}</ul>` : '';
  const form = modal('Оплаты по графику',`<p>${esc(item.title)} · связано ${rub(paid)} · остаток ${rub(outstandingAmount)}</p>` + history
    + (available.length ? selectField('Операция из выписки','operation',available.map(op => [op.id,describe(op)])) : '<p>Подходящих операций пока нет.</p>')
    + '<small>Операция должна быть целиком разнесена на проект графика с пустым месяцем БДР. Сумма и дата оплаты сохраняются.</small>',
  values => api('link-accrual-schedule',{schedule:item.id,operation:values.get('operation')}));
  const submit = form.querySelector('[type=submit]');
  submit.hidden = !available.length;
  submit.textContent = 'Привязать оплату';
}

function newSchedule() {
  const form = modal('Новый график',
    field('Договор или назначение','title','text','','maxlength="200" required')
    + selectField('ООО','entity',legalOptions(),entity)
    + `<div class="fields">${picker('Проект','project',activeProjects(),project)}
      ${selectField('Вид начисления','direction',[['income','Выручка'],['expense','Расход']])}
      ${selectField('Статья БДР','article',[])}${field('Первый месяц','start','month',period,'required')}
      ${field('Количество месяцев','count','number','12','min="1" max="60" step="1" required')}
      ${field('Сумма договора, ₽','amount','number','','min="0.01" step="0.01" required')}</div>`
    + '<small>Сумма делится равномерно по месяцам. График станет фактом БДР после подтверждения каждой строки.</small>',
  async values => {
    const payload = Object.fromEntries(values);
    payload.amount = (payload.direction === 'expense' ? '-' : '') + payload.amount;
    return {payload,preview:await api('preview-accrual-schedule',payload)};
  }, ({payload,preview}) => {
    const rows = preview.months.map(row => `<tr><td>${esc(row.month)}</td><td>${rub(row.amount)}</td></tr>`);
    const confirm = modal('Предпросмотр графика',
      `<p>${esc(payload.title)} · ${esc(payload.project)} · ${esc(payload.article)} · ${rub(preview.amount)}</p>`
      + table('Начисления по месяцам',['Месяц','Сумма'],rows),
    async () => {
      await api('accrual-schedule',payload);
      period = payload.start;
      return 'График создан.';
    });
    confirm.querySelector('[type=submit]').textContent = 'Создать график';
  });
  const update = () => {
    form.elements.article.innerHTML = idOptions(articlesFor(form.elements.direction.value,true).map(name => [name,name]));
  };
  form.elements.direction.onchange = update;
  update();
  form.querySelector('[type=submit]').textContent = 'Предпросмотр';
}

function handleScheduleAction(kind,arg) {
  if (!kind.startsWith('schedule-')) return false;
  if (dialog.open) dialog.close();
  const id = Number(arg);
  const item = data.accrual_schedules.find(row => row.id === id);
  if (kind === 'schedule-new') newSchedule();
  if (kind === 'schedule-months') scheduleMonths(item);
  if (kind === 'schedule-payments') schedulePayments(item);
  if (kind === 'schedule-remove') modal('Удалить черновик графика',
    `<p>${esc(item.title)}. Будут удалены строки графика.</p>`,() => api('remove-draft-schedule',{id}));
  if (kind === 'schedule-unlink') modal('Отвязать оплату', '<p>Операция останется в выписке. Подтверждённые начисления сохранятся.</p>',
    () => api('unlink-accrual-schedule',{operation:id}));
  if (kind === 'schedule-confirm' || kind === 'schedule-undo') {
    const row = data.schedule_months.find(entry => entry.id === id);
    const contract = data.accrual_schedules.find(entry => entry.id === row.schedule);
    const confirm = kind === 'schedule-confirm';
    const form = modal(confirm ? 'Подтвердить начисление' : 'Снять подтверждение',
      `<p>${esc(contract.title)} · ${esc(row.month)} · ${rub(row.amount)}</p>
       <small>${confirm ? 'Строка войдёт в факт БДР выбранного месяца.' : 'Строка вернётся к подтверждению. Банковские оплаты сохранятся.'}</small>`,
      () => api(confirm ? 'confirm-schedule-month' : 'undo-schedule-month',{id}));
    form.querySelector('[type=submit]').textContent = confirm ? 'Подтвердить' : 'Снять подтверждение';
  }
  return true;
}
