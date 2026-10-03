import type { AppBlueprint, AppBuilderItem } from "@workspace/api-client-react";

type PersonalAppKind = Extract<AppBlueprint["appKind"], "tasks" | "habits" | "expenses">;

type SeedItem = Pick<AppBuilderItem, "id" | "title" | "description" | "checked">;

type RuntimeConfig = {
  appKind: PersonalAppKind;
  storageKey: string;
  seedItems: SeedItem[];
};

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function functionalAppRuntime(config: RuntimeConfig) {
  const root = document.getElementById("personal-app");
  if (!root) return;

  const localDate = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const today = localDate();
  const newId = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const text = (value: unknown, limit = 240) =>
    typeof value === "string" ? value.trim().slice(0, limit) : "";
  const escapeHtml = (value: unknown) =>
    text(value, 1000).replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });
  const initialState = () => {
    if (config.appKind === "tasks") {
      return {
        tasks: config.seedItems.map((item) => ({
          id: text(item.id, 80) || newId(),
          title: text(item.title, 120) || "Tarea nueva",
          description: text(item.description),
          dueDate: "",
          completed: item.checked === true,
        })),
      };
    }
    if (config.appKind === "habits") {
      return {
        habits: config.seedItems.map((item) => ({
          id: text(item.id, 80) || newId(),
          title: text(item.title, 120) || "Hábito nuevo",
          description: text(item.description),
          completedDates: item.checked === true ? [today] : [],
        })),
      };
    }
    return { expenses: [] as Array<Record<string, unknown>> };
  };
  const defaultState = initialState();
  let canPersist = true;
  let state: Record<string, unknown> = defaultState;
  let taskFilter = "all";
  let selectedMonth = today.slice(0, 7);

  const normalizeSavedState = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultState;
    const record = value as Record<string, unknown>;
    if (config.appKind === "tasks") {
      if (!Array.isArray(record.tasks)) return defaultState;
      return {
        tasks: record.tasks.slice(0, 2000).flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const task = item as Record<string, unknown>;
          const title = text(task.title, 120);
          if (!title) return [];
          return [{
            id: text(task.id, 80) || newId(),
            title,
            description: text(task.description),
            dueDate: /^\d{4}-\d{2}-\d{2}$/.test(text(task.dueDate, 10)) ? text(task.dueDate, 10) : "",
            completed: task.completed === true,
          }];
        }),
      };
    }
    if (config.appKind === "habits") {
      if (!Array.isArray(record.habits)) return defaultState;
      return {
        habits: record.habits.slice(0, 1000).flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const habit = item as Record<string, unknown>;
          const title = text(habit.title, 120);
          if (!title) return [];
          const completedDates = Array.isArray(habit.completedDates)
            ? habit.completedDates
                .filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))
                .slice(-730)
            : [];
          return [{
            id: text(habit.id, 80) || newId(),
            title,
            description: text(habit.description),
            completedDates,
          }];
        }),
      };
    }
    if (!Array.isArray(record.expenses)) return defaultState;
    return {
      expenses: record.expenses.slice(0, 10000).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const expense = item as Record<string, unknown>;
        const title = text(expense.title, 120);
        const amount = Number(expense.amount);
        const date = text(expense.date, 10);
        if (!title || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
        return [{
          id: text(expense.id, 80) || newId(),
          title,
          amount,
          category: text(expense.category, 80) || "Otros",
          date,
        }];
      }),
    };
  };

  try {
    const saved = localStorage.getItem(config.storageKey);
    if (saved) state = normalizeSavedState(JSON.parse(saved));
  } catch {
    canPersist = false;
  }

  const statusMessage = () => {
    const status = root.querySelector("[data-storage-status]");
    if (!status) return;
    status.textContent = canPersist
      ? "Tus datos se guardan en este navegador; no se sincronizan ni se envían."
      : "Esta vista no permite guardar datos de forma permanente; descargá el HTML y abrilo en un navegador compatible.";
  };
  const save = () => {
    try {
      localStorage.setItem(config.storageKey, JSON.stringify(state));
      canPersist = true;
    } catch {
      canPersist = false;
    }
    statusMessage();
  };
  const getArray = (name: string): Array<Record<string, unknown>> =>
    Array.isArray(state[name]) ? (state[name] as Array<Record<string, unknown>>) : [];
  const money = (amount: number) =>
    new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(amount);
  const formatDate = (value: string) => {
    if (!value) return "";
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(new Date(year, month - 1, day));
  };
  const setField = (form: HTMLFormElement, name: string, value: string) => {
    const field = form.elements.namedItem(name);
    if (field && "value" in field) (field as HTMLInputElement | RadioNodeList).value = value;
  };
  const clearEdit = (form: HTMLFormElement) => {
    form.reset();
    delete form.dataset.editId;
    const submit = form.querySelector<HTMLButtonElement>("[data-submit-label]");
    if (submit) submit.textContent = form.dataset.createLabel || "Agregar";
    const cancel = form.querySelector<HTMLButtonElement>("[data-cancel-edit]");
    if (cancel) cancel.hidden = true;
    if (form.elements.namedItem("date")) setField(form, "date", today);
  };
  const beginEdit = (
    formId: string,
    item: Record<string, unknown>,
    fields: string[],
  ) => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    form.dataset.editId = String(item.id);
    for (const field of fields) setField(form, field, String(item[field] ?? ""));
    const submit = form.querySelector<HTMLButtonElement>("[data-submit-label]");
    if (submit) submit.textContent = "Guardar cambios";
    const cancel = form.querySelector<HTMLButtonElement>("[data-cancel-edit]");
    if (cancel) cancel.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    const firstField = form.elements.namedItem(fields[0]);
    if (firstField && "focus" in firstField && typeof firstField.focus === "function") firstField.focus();
  };
  const emptyState = (message: string) => `<p class="empty-state">${escapeHtml(message)}</p>`;
  const statCard = (label: string, value: string) =>
    `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;

  const renderTasks = () => {
    const tasks = getArray("tasks");
    const visible = tasks.filter((task) =>
      taskFilter === "all" ||
      (taskFilter === "done" ? task.completed === true : task.completed !== true),
    );
    const completed = tasks.filter((task) => task.completed === true).length;
    const pending = tasks.length - completed;
    const rows = visible.length
      ? visible.map((task) => {
          const id = escapeHtml(task.id);
          const title = escapeHtml(task.title);
          const description = escapeHtml(task.description);
          const date = escapeHtml(task.dueDate);
          return `<article class="record-row${task.completed === true ? " is-complete" : ""}">
            <button class="record-check" type="button" data-action="toggle-task" data-id="${id}" aria-pressed="${task.completed === true}" aria-label="${task.completed === true ? "Marcar pendiente" : "Completar"}: ${title}">${task.completed === true ? "✓" : ""}</button>
            <div class="record-copy"><strong>${title}</strong>${description ? `<span>${description}</span>` : ""}${date ? `<small>Fecha: ${escapeHtml(formatDate(String(task.dueDate)))}</small>` : ""}</div>
            <div class="record-actions"><button type="button" data-action="edit-task" data-id="${id}" aria-label="Editar ${title}">Editar</button><button type="button" data-action="delete-task" data-id="${id}" aria-label="Borrar ${title}">Borrar</button></div>
          </article>`;
        }).join("")
      : emptyState(taskFilter === "done" ? "Todavía no completaste tareas." : "No hay tareas en esta vista. Agregá la primera arriba.");

    root.innerHTML = `<section class="personal-workspace">
      <div class="workspace-stats">${statCard("Pendientes", String(pending))}${statCard("Completadas", String(completed))}${statCard("Total", String(tasks.length))}</div>
      <form id="task-form" class="entry-form" data-create-label="Agregar tarea">
        <h2 id="task-form-heading">Sumá una tarea</h2>
        <div class="form-grid">
          <label class="field field-wide">Tarea<input name="title" maxlength="120" required placeholder="¿Qué tenés que hacer?" autocomplete="off"></label>
          <label class="field field-wide">Detalle (opcional)<input name="description" maxlength="240" placeholder="Agregá una nota"></label>
          <label class="field">Fecha (opcional)<input name="dueDate" type="date"></label>
        </div>
        <div class="form-actions"><button class="primary-button" type="submit" data-submit-label>Agregar tarea</button><button class="text-button" type="button" data-action="cancel-task-edit" data-cancel-edit hidden>Cancelar edición</button></div>
      </form>
      <div class="workspace-list-heading"><div><h2>Tus tareas</h2><p>Marcá lo que terminaste, editá los detalles o quitá lo que ya no necesitás.</p></div></div>
      <div class="filter-row" role="group" aria-label="Filtrar tareas">
        <button type="button" data-action="filter-tasks" data-filter="all" aria-pressed="${taskFilter === "all"}">Todas</button>
        <button type="button" data-action="filter-tasks" data-filter="open" aria-pressed="${taskFilter === "open"}">Pendientes</button>
        <button type="button" data-action="filter-tasks" data-filter="done" aria-pressed="${taskFilter === "done"}">Completadas</button>
      </div>
      <div class="record-list" aria-live="polite">${rows}</div>
      <p class="storage-status" data-storage-status></p>
    </section>`;
    statusMessage();
  };

  const streakFor = (dates: string[]) => {
    const completed = new Set(dates);
    const cursor = new Date();
    if (!completed.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (completed.has(localDate(cursor)) && streak < 730) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  };

  const renderHabits = () => {
    const habits = getArray("habits");
    const completedToday = habits.filter((habit) =>
      Array.isArray(habit.completedDates) && habit.completedDates.includes(today),
    ).length;
    const completionRate = habits.length ? Math.round((completedToday / habits.length) * 100) : 0;
    const rows = habits.length
      ? habits.map((habit) => {
          const dates = Array.isArray(habit.completedDates) ? (habit.completedDates as string[]) : [];
          const doneToday = dates.includes(today);
          const id = escapeHtml(habit.id);
          const title = escapeHtml(habit.title);
          const description = escapeHtml(habit.description);
          return `<article class="record-row${doneToday ? " is-complete" : ""}">
            <button class="record-check" type="button" data-action="toggle-habit" data-id="${id}" aria-pressed="${doneToday}" aria-label="${doneToday ? "Desmarcar" : "Registrar"} ${title} por hoy">${doneToday ? "✓" : ""}</button>
            <div class="record-copy"><strong>${title}</strong>${description ? `<span>${description}</span>` : ""}<small>Racha: ${streakFor(dates)} ${streakFor(dates) === 1 ? "día" : "días"}</small></div>
            <div class="record-actions"><button type="button" data-action="edit-habit" data-id="${id}" aria-label="Editar ${title}">Editar</button><button type="button" data-action="delete-habit" data-id="${id}" aria-label="Borrar ${title}">Borrar</button></div>
          </article>`;
        }).join("")
      : emptyState("Agregá un hábito para empezar a registrar tu constancia.");

    root.innerHTML = `<section class="personal-workspace">
      <div class="workspace-stats">${statCard("Hechos hoy", `${completedToday} / ${habits.length}`)}${statCard("Avance de hoy", `${completionRate}%`)}${statCard("Hábitos", String(habits.length))}</div>
      <div class="daily-progress" role="progressbar" aria-label="Avance de hábitos de hoy" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completionRate}"><span style="width:${completionRate}%"></span></div>
      <form id="habit-form" class="entry-form" data-create-label="Agregar hábito">
        <h2>Tu rutina</h2>
        <div class="form-grid">
          <label class="field field-wide">Hábito<input name="title" maxlength="120" required placeholder="Por ejemplo, salir a caminar" autocomplete="off"></label>
          <label class="field field-wide">Detalle (opcional)<input name="description" maxlength="240" placeholder="Cuándo o cómo lo vas a hacer"></label>
        </div>
        <div class="form-actions"><button class="primary-button" type="submit" data-submit-label>Agregar hábito</button><button class="text-button" type="button" data-action="cancel-habit-edit" data-cancel-edit hidden>Cancelar edición</button></div>
      </form>
      <div class="workspace-list-heading"><div><h2>Hábitos para hoy</h2><p>El registro de cada día se conserva para calcular tus rachas.</p></div></div>
      <div class="record-list" aria-live="polite">${rows}</div>
      <p class="storage-status" data-storage-status></p>
    </section>`;
    statusMessage();
  };

  const renderExpenses = () => {
    const expenses = getArray("expenses");
    const monthExpenses = expenses.filter((expense) => String(expense.date).startsWith(selectedMonth));
    const monthTotal = monthExpenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
    const rows = monthExpenses.length
      ? monthExpenses
          .slice()
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .map((expense) => {
            const id = escapeHtml(expense.id);
            const title = escapeHtml(expense.title);
            return `<tr><td>${escapeHtml(formatDate(String(expense.date)))}</td><td><strong>${title}</strong><small>${escapeHtml(expense.category)}</small></td><td class="amount-cell">${escapeHtml(money(Number(expense.amount)))}</td><td class="record-actions"><button type="button" data-action="edit-expense" data-id="${id}" aria-label="Editar ${title}">Editar</button><button type="button" data-action="delete-expense" data-id="${id}" aria-label="Borrar ${title}">Borrar</button></td></tr>`;
          }).join("")
      : `<tr><td colspan="4">${emptyState("No hay gastos registrados en este mes. Cargá el primero arriba.")}</td></tr>`;

    root.innerHTML = `<section class="personal-workspace">
      <div class="workspace-stats">${statCard("Total del mes", money(monthTotal))}${statCard("Gastos del mes", String(monthExpenses.length))}${statCard("Registros", String(expenses.length))}</div>
      <form id="expense-form" class="entry-form" data-create-label="Guardar gasto">
        <h2>Registrar un gasto</h2>
        <div class="form-grid">
          <label class="field field-wide">¿En qué gastaste?<input name="title" maxlength="120" required placeholder="Por ejemplo, supermercado" autocomplete="off"></label>
          <label class="field">Monto<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0"></label>
          <label class="field">Categoría<select name="category" required><option value="Comida">Comida</option><option value="Transporte">Transporte</option><option value="Vivienda">Vivienda</option><option value="Salud">Salud</option><option value="Servicios">Servicios</option><option value="Ocio">Ocio</option><option value="Otros">Otros</option></select></label>
          <label class="field">Fecha<input name="date" type="date" required value="${today}"></label>
        </div>
        <div class="form-actions"><button class="primary-button" type="submit" data-submit-label>Guardar gasto</button><button class="text-button" type="button" data-action="cancel-expense-edit" data-cancel-edit hidden>Cancelar edición</button></div>
      </form>
      <div class="workspace-list-heading expense-list-heading"><div><h2>Movimientos</h2><p>Los totales corresponden al mes seleccionado.</p></div><label class="month-picker">Mes<input id="expense-month" type="month" value="${escapeHtml(selectedMonth)}"></label></div>
      <div class="table-wrap"><table class="expense-table"><thead><tr><th>Fecha</th><th>Gasto</th><th>Monto</th><th><span class="visually-hidden">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="expense-footer-actions"><button class="secondary-button" type="button" data-action="export-expenses">Descargar CSV</button></div>
      <p class="storage-status" data-storage-status></p>
    </section>`;
    statusMessage();
  };

  const render = () => {
    if (config.appKind === "tasks") renderTasks();
    else if (config.appKind === "habits") renderHabits();
    else renderExpenses();
  };

  const cancelForm = (formId: string) => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (form) clearEdit(form);
  };

  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form || !root.contains(form)) return;
    const fields = new FormData(form);
    event.preventDefault();

    if (form.id === "task-form") {
      const title = text(fields.get("title"), 120);
      if (!title) return;
      const task = {
        id: form.dataset.editId || newId(),
        title,
        description: text(fields.get("description")),
        dueDate: text(fields.get("dueDate"), 10),
        completed: false,
      };
      const tasks = getArray("tasks");
      state.tasks = form.dataset.editId
        ? tasks.map((current) => current.id === task.id ? { ...current, ...task, completed: current.completed === true } : current)
        : [...tasks, task];
      save();
      renderTasks();
    } else if (form.id === "habit-form") {
      const title = text(fields.get("title"), 120);
      if (!title) return;
      const habit = {
        id: form.dataset.editId || newId(),
        title,
        description: text(fields.get("description")),
        completedDates: [],
      };
      const habits = getArray("habits");
      state.habits = form.dataset.editId
        ? habits.map((current) => current.id === habit.id ? { ...current, ...habit, completedDates: current.completedDates } : current)
        : [...habits, habit];
      save();
      renderHabits();
    } else if (form.id === "expense-form") {
      const title = text(fields.get("title"), 120);
      const amount = Number(fields.get("amount"));
      const date = text(fields.get("date"), 10);
      if (!title || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const expense = {
        id: form.dataset.editId || newId(),
        title,
        amount,
        category: text(fields.get("category"), 80) || "Otros",
        date,
      };
      const expenses = getArray("expenses");
      state.expenses = form.dataset.editId
        ? expenses.map((current) => current.id === expense.id ? expense : current)
        : [...expenses, expense];
      selectedMonth = date.slice(0, 7);
      save();
      renderExpenses();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>("[data-action]");
    if (!button || !root.contains(button)) return;
    const action = button.dataset.action;
    const id = button.dataset.id;

    if (action === "filter-tasks") {
      taskFilter = button.dataset.filter || "all";
      renderTasks();
      return;
    }
    if (action === "cancel-task-edit") return cancelForm("task-form");
    if (action === "cancel-habit-edit") return cancelForm("habit-form");
    if (action === "cancel-expense-edit") return cancelForm("expense-form");
    if (action === "toggle-task" && id) {
      state.tasks = getArray("tasks").map((task) => task.id === id ? { ...task, completed: task.completed !== true } : task);
      save();
      return renderTasks();
    }
    if (action === "edit-task" && id) {
      const task = getArray("tasks").find((item) => item.id === id);
      if (task) beginEdit("task-form", task, ["title", "description", "dueDate"]);
      return;
    }
    if (action === "delete-task" && id) {
      state.tasks = getArray("tasks").filter((task) => task.id !== id);
      save();
      return renderTasks();
    }
    if (action === "toggle-habit" && id) {
      state.habits = getArray("habits").map((habit) => {
        if (habit.id !== id) return habit;
        const dates = Array.isArray(habit.completedDates) ? (habit.completedDates as string[]) : [];
        return {
          ...habit,
          completedDates: dates.includes(today) ? dates.filter((date) => date !== today) : [...dates, today].slice(-730),
        };
      });
      save();
      return renderHabits();
    }
    if (action === "edit-habit" && id) {
      const habit = getArray("habits").find((item) => item.id === id);
      if (habit) beginEdit("habit-form", habit, ["title", "description"]);
      return;
    }
    if (action === "delete-habit" && id) {
      state.habits = getArray("habits").filter((habit) => habit.id !== id);
      save();
      return renderHabits();
    }
    if (action === "edit-expense" && id) {
      const expense = getArray("expenses").find((item) => item.id === id);
      if (expense) beginEdit("expense-form", expense, ["title", "amount", "category", "date"]);
      return;
    }
    if (action === "delete-expense" && id) {
      state.expenses = getArray("expenses").filter((expense) => expense.id !== id);
      save();
      return renderExpenses();
    }
    if (action === "export-expenses") {
      const rows = [
        ["Fecha", "Concepto", "Categoría", "Monto ARS"],
        ...getArray("expenses").map((expense) => [
          String(expense.date),
          String(expense.title),
          String(expense.category),
          String(expense.amount),
        ]),
      ];
      const csv = rows.map((row) => row.map((value) => {
        const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
        return `"${safe.replace(/"/g, '""')}"`;
      }).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "mis-gastos.csv";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.id === "expense-month" && root.contains(target)) {
      selectedMonth = /^\d{4}-\d{2}$/.test(target.value) ? target.value : today.slice(0, 7);
      renderExpenses();
    }
  });

  render();
}

export function buildPersonalAppRuntime(blueprint: AppBlueprint, appNamespace?: string): {
  markup: string;
  script: string;
} {
  const appKind = blueprint.appKind as PersonalAppKind;
  const seedItems = blueprint.sections
    .filter((section) => section.type === "list" || section.type === "features")
    .flatMap((section) => section.items)
    .slice(0, 100)
    .map((item) => ({
      id: item.id.slice(0, 80),
      title: item.title.slice(0, 120),
      description: item.description.slice(0, 240),
      checked: item.checked,
    }));
  const appSlug = blueprint.title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "mi-app";
  const namespace = appNamespace
    ?.replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 80) || appSlug;
  const config: RuntimeConfig = {
    appKind,
    storageKey: `programa-hablando:${appKind}:${namespace}:v1`,
    seedItems,
  };

  return {
    markup: `<div class="personal-app-shell"><div id="personal-app" aria-live="polite"><p class="empty-state">Preparando tu app…</p></div></div>`,
    script: `<script>var __name=(target,name)=>Object.defineProperty(target,"name",{value:name,configurable:true});(${functionalAppRuntime.toString()})(${safeJsonForScript(config)});</script>`,
  };
}