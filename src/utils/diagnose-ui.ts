/**
 * Диагностика «список проектов заблокирован» (2026-09-21).
 *
 * Жалоба: в форме правки заявки выбор проекта и группы перестаёт открываться.
 * В консоли пусто, помогает открыть и закрыть панель разработчика (Ctrl+Shift+I)
 * — то есть дело не в логике плагина, а в состоянии отрисовщика: закрытие
 * панели дважды меняет размер окна и заставляет пересчитать раскладку.
 *
 * Разобрать это по коду не удалось: ни одно место плагина селекторы не
 * выключает, CSS их не гасит, полноэкранных перекрытий плагин не создаёт.
 * Поэтому — снимок состояния в момент, когда беда видна.
 *
 * Решающая проверка здесь — `elementFromPoint` в середине селектора:
 *   - вернул сам селектор → сверху ничего нет, значит подвисло состояние
 *     нативного выпадающего списка Chromium (такое бывает, когда элемент с
 *     раскрытым списком убирают из DOM) — лечится тем самым Ctrl+Shift+I;
 *   - вернул что-то другое → это «что-то» и перехватывает щелчки, и в отчёте
 *     будет его класс.
 *
 * Снимок только читает DOM и ничего не меняет.
 */

/** Что удалось узнать про один селектор. */
interface SelectReport {
  label: string;
  disabled: boolean;
  options: number;
  rect: string;
  pointerEvents: string;
  visibility: string;
  opacity: string;
  /** Что реально лежит в середине селектора. */
  topmost: string;
  covered: boolean;
}

function describe(el: Element | null): string {
  if (!el) return 'ничего (за пределами окна?)';
  const tag = el.tagName.toLowerCase();
  const cls = el.classList.length > 0 ? '.' + Array.from(el.classList).join('.') : '';
  return `${tag}${cls}`;
}

/** Подпись селектора — текст предыдущего label, иначе первый вариант списка. */
function labelOf(select: HTMLSelectElement): string {
  const prev = select.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === 'label' && prev.textContent) {
    return prev.textContent.trim();
  }
  return select.options.length > 0 ? `список из ${select.options.length}` : 'без подписи';
}

function inspect(select: HTMLSelectElement): SelectReport {
  const rect = select.getBoundingClientRect();
  const style = window.getComputedStyle(select);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  return {
    label: labelOf(select),
    disabled: select.disabled,
    options: select.options.length,
    rect: `${Math.round(rect.width)}×${Math.round(rect.height)} в (${Math.round(rect.left)}, ${Math.round(rect.top)})`,
    pointerEvents: style.pointerEvents,
    visibility: style.visibility,
    opacity: style.opacity,
    topmost: describe(top),
    covered: top !== select && !select.contains(top),
  };
}

/**
 * Собирает отчёт по всем селекторам вьюхи заявок. Возвращает текст для
 * консоли; вторым значением — короткий вывод для всплывающего сообщения.
 */
export function diagnoseBlockedSelects(): { report: string; verdict: string } {
  const view = document.querySelector('.workspace-leaf-content[data-type="sbe-requests-view"]');
  const root: ParentNode = view ?? document;
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>('select'));

  const lines: string[] = [];
  lines.push(`Селекторов на экране: ${selects.length}`);
  lines.push(`Вьюха заявок найдена: ${view ? 'да' : 'НЕТ — снимок по всему документу'}`);
  lines.push(`Фокус сейчас на: ${describe(document.activeElement)}`);

  // Элементы, вырванные из потока, — единственные, кто может перекрыть поле,
  // оставаясь незаметным.
  const floating = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const pos = window.getComputedStyle(el).position;
    return pos === 'fixed' || pos === 'absolute';
  });
  lines.push(`Элементов с position fixed/absolute в документе: ${floating.length}`);

  let covered = 0;
  let empty = 0;
  for (const select of selects) {
    const r = inspect(select);
    if (r.covered) covered += 1;
    if (r.options <= 1) empty += 1;
    lines.push(
      `— «${r.label}»: вариантов ${r.options}, disabled=${r.disabled}, ` +
      `pointer-events=${r.pointerEvents}, visibility=${r.visibility}, opacity=${r.opacity}, ` +
      `размер ${r.rect}, сверху лежит ${r.topmost}${r.covered ? '  ← ПЕРЕКРЫТ' : ''}`,
    );
  }

  let verdict: string;
  if (selects.length === 0) {
    verdict = 'Селекторов на экране нет — откройте форму правки заявки и повторите.';
  } else if (covered > 0) {
    verdict = `Перекрыто селекторов: ${covered}. Что именно лежит сверху — в консоли.`;
  } else if (empty === selects.length) {
    verdict = 'Все списки пусты — дело в данных, а не в отрисовке. Нажмите «Синхронизировать».';
  } else {
    verdict = 'Сверху ничего не лежит, списки наполнены, выключений нет — '
      + 'похоже на подвисшее состояние выпадающего списка в самом Chromium.';
  }

  lines.push('');
  lines.push(`ВЫВОД: ${verdict}`);
  return { report: lines.join('\n'), verdict };
}
