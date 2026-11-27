const productPlanStart = '2026-11';

function projectAncestors(name) {
  const path = [name];
  const parents = data.projectParents || {};
  while (Object.hasOwn(parents,path.at(-1))) path.push(parents[path.at(-1)]);
  return path;
}

function projectInScope(name,scope = project) {
  return !scope || name === scope || projectAncestors(name).includes(scope);
}

function weightedExpenseFields() {
  return `<details class="weighted-expense">
    <summary>Распределить по часам или операциям</summary>
    <small>Расчёт возьмёт статью и месяц БДР из первой строки и заполнит доли проекта.</small>
    ${selectField('База распределения','weightBasis',[['hours','Отработанные часы'],['operations','Количество операций']],null,false)}
    <div class="weighted-rows"></div>
    <div class="actions">
      <button type="button" class="button" id="weight-add">+ Проект в расчёт</button>
      <button type="button" class="button" id="weight-calculate">Рассчитать доли</button>
    </div>
    <small class="weight-status" role="status"></small>
  </details>`;
}

function initWeightedExpense(form,op,makeRow,update) {
  const details = form.querySelector('.weighted-expense');
  if (!details) return () => null;
  const rows = details.querySelector('.weighted-rows');
  const status = details.querySelector('.weight-status');
  const add = details.querySelector('#weight-add');
  const calculate = details.querySelector('#weight-calculate');
  const projects = [['','Выберите проект'],...activeProjects().map(name => [name,name])];
  let calculated = null;
  const addRow = () => rows.insertAdjacentHTML('beforeend',`<div class="fields weighted-row">
    ${selectField('Проект в расчёте','weightProject',projects,null,false)}
    ${field('Часы или количество','weightValue','number','','min="0" step="any"')}
    <button type="button" class="button" data-weight-remove>Убрать</button></div>`);
  addRow();
  addRow();
  add.onclick = addRow;
  rows.addEventListener('click',event => {
    if (event.target.hasAttribute('data-weight-remove')) event.target.closest('.weighted-row').remove();
  });
  const invalidate = () => {
    if (calculated) {
      calculated = null;
      status.textContent = 'Для обновления основания пересчитайте доли.';
    }
  };
  form.addEventListener('input',event => {
    if (event.target.closest('.weighted-expense') || event.target.matches('.split [name=project], .split [name=amount]')) invalidate();
  });
  form.addEventListener('click',event => {
    if (event.target.matches('#add-line, .split .remove, [data-weight-remove], #weight-add')) invalidate();
  });
  calculate.onclick = async () => {
    const first = form.querySelector('.split');
    const article = first?.querySelector('[name=article]').value;
    const accrual = first?.querySelector('[name=accrual]').value;
    const accrual_article = first?.querySelector('[name=accrualArticle]').value;
    if (!article) {
      status.textContent = 'Сначала выберите статью в первой строке.';
      return;
    }
    const basis = details.querySelector('[name=weightBasis]').value;
    const weights = [...rows.querySelectorAll('.weighted-row')].map(row => ({
      project:row.querySelector('[name=weightProject]').value,
      value:row.querySelector('[name=weightValue]').value
    }));
    const basisDraft = {basis,weights};
    calculate.disabled = true;
    try {
      const {shares} = await api('preview-weighted-expense',{id:op.id,...basisDraft});
      if (!dialog.open || !form.isConnected) return;
      form.querySelector('#lines').innerHTML = Object.entries(shares).map(([project,amount]) =>
        makeRow({project,amount,article,accrual,accrual_article})).join('');
      calculated = basisDraft;
      update();
      status.textContent = 'Доли рассчитаны. После сохранения основание попадёт в журнал.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      calculate.disabled = false;
    }
  };
  return () => calculated;
}
