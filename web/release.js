function periodsReport() {
  const closures = data.periodClosures.filter(row => inEntity(row.entity));
  const rows = legalOptions().filter(([id]) => inEntity(id)).map(([id,label]) => {
    const closed = closures.find(row => row.entity === id && row.month === period);
    return `<tr><td>${esc(label)}</td><td><span class="pill ${closed ? '' : 'pending'}">${closed ? 'Закрыт' : 'Открыт'}</span></td>
      <td class="wrap">${closed ? esc(closed.note) + '<small>' + esc(closed.actor) + '</small>' : '—'}</td>
      <td>${button(closed ? 'Открыть для правки' : 'Проверить и закрыть',(closed ? 'period-reopen:' : 'period-close:') + id)}</td></tr>`;
  });
  const history = closures.map(row => `<tr><td>${esc(row.month)}</td><td>${esc(entityName(row.entity))}</td><td>${esc(row.closed_at)}</td>
    <td>${esc(row.actor)}</td><td class="wrap">${esc(row.note)}</td></tr>`);
  const auditNames = {
    'close-period':'Закрытие месяца','reopen-period':'Повторное открытие','allocate':'Разнесение операции',
    'request':'Создание заявки','review':'Решение по заявке','request-comment':'Комментарий',
    'request-attach':'Вложение','link-payment':'Связь оплаты','import-tochka':'Импорт Точки','import':'Импорт CSV',
    'confirm-schedule-month':'Подтверждение начисления','pnl-template':'Настройка P&L','accrual':'Ручное начисление',
    'monthly-rule':'Изменение правила проекта','monthly-rule-plan':'План по правилу','bonus-confirm':'Начисление премии',
    'bonus-clear':'Отмена начисления премии','weekly-action-save':'Действие на неделю','weekly-action-status':'Статус действия'
  };
  const audit = data.audit.map(row => `<tr><td>${esc(row.created)}</td><td>${esc(row.actor)}</td>
    <td>${esc(auditNames[row.action] || row.action)}</td><td class="wrap">${esc(row.target)}</td></tr>`);
  return header('Закрытие месяца','Проверка данных и защита закрытых периодов по ООО') + entityPeriodFilters()
    + table('Выбранный период',['ООО','Статус','Основание',''],rows)
    + '<div class="calendar-gap"></div>' + table('Закрытые месяцы',['Месяц','ООО','Закрыт, UTC','Кем','Основание'],history)
    + '<div class="calendar-gap"></div>' + table('Последние действия',['Время, UTC','Пользователь','Действие','Объект'],audit);
}

async function closePeriod(id) {
  try {
    const payload = {entity:id,month:period};
    const checks = await api('preview-close',payload);
    const pending = Object.values(checks).some(value => Array.isArray(value) ? value.length : value);
    const rows = [
      ['Счета без сверки',checks.unreconciled.join(', ') || '0'],
      ['Операции без разнесения',checks.unassigned],
      ['Ожидаемые документы',checks.documents],
      ['Неподтверждённые начисления из графиков',checks.schedules],
      ['Премии к проверке',checks.bonuses]
    ].map(([name,value]) => `<tr><td>${name}</td><td>${esc(value)}</td></tr>`);
    const form = modal('Проверка закрытия',`<p>${esc(entityName(id))} · ${esc(payload.month)}</p>`
      + table('Замечания',['Проверка','Результат'],rows)
      + (pending ? '<label class="finance-option"><input type="checkbox" name="exceptions" required> Закрыть с указанными замечаниями</label>' : '')
      + field('Основание','note','text','','maxlength="200" required'),
    values => api('close-period',{...payload,note:values.get('note'),exceptions:values.has('exceptions'),expectedChecks:checks}));
    form.querySelector('[type=submit]').textContent = 'Закрыть месяц';
  } catch (error) {
    notify(error.message);
  }
}

function closeBadge() {
  const items = data.periodClosures.filter(row => row.month === period && inEntity(row.entity));
  return items.length ? `<span class="pill">Закрыт · ${items.map(row => esc(entityName(row.entity))).join(', ')}</span>` : '';
}

async function exportReport() {
  const parse = cell => {
    const text = cell.innerText.trim();
    const amount = text.match(/^([-−]?\d[\d\s]*(?:,\d+)?)\s*₽$/u);
    return amount ? Number(amount[1].replace(/\s/g,'').replace('−','-').replace(',','.')) : text;
  };
  const sheets = [...content.querySelectorAll('.table-card')].flatMap(section => {
    const heading = section.querySelector('h2')?.innerText;
    const headings = [...section.querySelectorAll('thead th')];
    if (!heading || !headings.length) return [];
    const indices = headings.flatMap((node,index) => node.innerText ? [index] : []);
    return [{heading,rows:[
      indices.map(i => headings[i].innerText),
      ...[...section.querySelectorAll('tbody tr')].map(row => indices.map(i => parse(row.cells[i])))
    ]}];
  });
  const selected = id => content.querySelector('#' + id)?.selectedOptions[0]?.textContent;
  const scope = [period,entity ? entityName(Number(entity)) : 'Все ООО',view === 'cash' && account ? bankName(Number(account)) : '',
    project || 'Все проекты',selected('scenario'),selected('version')].filter(Boolean).join(' · ');
  try {
    const response = await fetch('/api/export-report',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({report:view,scope,sheets})});
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob());
    const file = document.createElement('a');
    file.href = url;
    file.download = 'qodex-' + view + '-' + period + '.xlsx';
    file.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  } catch (error) {
    notify(error.message);
  }
}

function requestThread(id) {
  const request = data.requests.find(item => item.id === id);
  const comments = data.requestComments.filter(item => item.request === id).map(item =>
    `<tr><td>${esc(item.actor)}<small>${esc(item.created)}</small></td><td class="wrap">${esc(item.body)}</td></tr>`);
  const uploads = data.requestAttachments.filter(item => item.request === id).map(item =>
    `<tr><td><a href="/api/request-attachment/${item.id}" download>${esc(item.name)}</a></td><td>${esc(item.actor)}</td></tr>`);
  const form = modal('Обсуждение заявки',`<p><strong>${esc(request.title)}</strong></p>`
    + table('Комментарии',['Автор, время UTC','Комментарий'],comments,'Комментариев пока нет.',button('+ Комментарий','thread-comment:' + id))
    + table('Вложения',['Файл','Автор'],uploads,'PDF пока не добавлен.',button('+ PDF','thread-attach:' + id)),() => {});
  form.querySelector('[type=submit]').hidden = true;
}

function requestAlerts() {
  const requests = new Map(data.requests.map(item => [item.id,item]));
  const rows = data.requestAlerts.map(item =>
    `<tr><td class="wrap">${item.seen ? '' : '<span class="pill pending">Новое</span> '}${esc(item.body)}<small>${esc(item.created)}</small></td>
      <td class="wrap">${esc(requests.get(item.request).title)}</td><td>${button('Открыть','thread-open:' + item.request)}</td></tr>`);
  const form = modal('Уведомления',table('Заявки',['Обновление','Заявка',''],rows,'Уведомлений пока нет.'),
    () => api('request-alert-seen',{}));
  form.querySelector('[type=submit]').textContent = 'Отметить прочитанными';
  form.querySelector('[type=submit]').hidden = !data.requestAlerts.some(item => !item.seen);
}

async function refreshView() {
  const from = view;
  const previous = data;
  if (dialog.open) return;
  try {
    const refreshed = await api('state');
    if (view === from && data === previous && !dialog.open) {
      data = refreshed;
      render();
    }
  } catch (error) {
    notify(error.message);
  }
}

function releaseAction(kind,arg) {
  const id = Number(arg);
  if (kind === 'period-close') closePeriod(id);
  else if (kind === 'period-reopen') modal('Открыть месяц для правки',`<p>${esc(entityName(id))} · ${esc(period)}</p>`
    + field('Причина','note','text','','maxlength="200" required'),
    values => api('reopen-period',{entity:id,month:period,note:values.get('note')}));
  else if (kind === 'export-report') exportReport();
  else if (kind === 'request-alerts') refreshView().then(requestAlerts);
  else if (kind === 'release-refresh') refreshView();
  else if (kind.startsWith('thread-')) {
    if (dialog.open) dialog.close();
    if (kind === 'thread-open') requestThread(id);
    if (kind === 'thread-comment') modal('Комментарий',
      '<label>Текст<textarea name="body" required maxlength="2000" rows="3"></textarea></label>',
      values => api('request-comment',{id,body:values.get('body')}));
    if (kind === 'thread-attach') modal('Прикрепить PDF',
      '<label>PDF до 1 МБ<input name="file" type="file" accept=".pdf,application/pdf" required></label>',
      async values => {
        const file = values.get('file');
        if (!file.size || file.size > 1_000_000) throw new Error('Выберите PDF до 1 МБ.');
        const encoded = await new Promise((resolve,reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Не удалось открыть файл.'));
          reader.readAsDataURL(file);
        });
        return api('request-attach',{id,name:file.name,file:encoded});
      });
  } else return false;
  return true;
}
