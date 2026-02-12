import { store } from '../store.js';
import { gateway } from '../gateway/connection.js';
import { parseTaskMessage, createDeltaAccumulator } from '../parser.js';
import { renderStatsBar } from './stats.js';
import { showToast } from './status.js';

let unsubConnection = null;
let unsubEvents = null;
let accumulator = createDeltaAccumulator();

export function renderMain(container) {
  container.innerHTML = `
    <div class="view">
      <div class="header">
        <h1>Agent Forge Quest</h1>
        <div class="header-actions">
          <div class="status-dot" id="statusDot" title="Connection status"></div>
          <button class="icon-btn" onclick="location.hash='#settings'" title="Settings">&#x2699;&#xFE0F;</button>
        </div>
      </div>
      <div id="statsContainer"></div>
      <div id="tasksContainer"></div>
    </div>
  `;

  renderFromState();
  setupConnectionListener();
  setupEventListener();
}

function renderFromState() {
  const { tasks } = store.get();
  const statsContainer = document.getElementById('statsContainer');
  const tasksContainer = document.getElementById('tasksContainer');

  if (!statsContainer || !tasksContainer) return;

  if (tasks.stats.streak > 0 || tasks.stats.xp > 0 || tasks.day) {
    renderStatsBar(statsContainer);
  }

  if (tasks.items.length > 0) {
    renderTaskList(tasksContainer, tasks.items);
  } else if (tasks.rawMessage) {
    tasksContainer.innerHTML = `<div class="raw-message">${escapeHtml(tasks.rawMessage)}</div>`;
  } else {
    const { connection } = store.get();
    if (connection.state === 'CONNECTED') {
      tasksContainer.innerHTML = `
        <div class="loading">
          <div class="loading-spinner"></div>
          <p style="margin-top:12px">Fetching today's tasks...</p>
        </div>
      `;
    } else if (connection.state === 'CONNECTING' || connection.state === 'RECONNECTING') {
      tasksContainer.innerHTML = `
        <div class="loading">
          <div class="loading-spinner"></div>
          <p style="margin-top:12px">Connecting to gateway...</p>
        </div>
      `;
    } else {
      tasksContainer.innerHTML = `
        <div class="empty-state">
          <p>No tasks loaded yet.</p>
          <button onclick="location.hash='#settings'">Configure Gateway</button>
        </div>
      `;
    }
  }

  updateStatusDot();
}

function renderTaskList(container, items) {
  const { pendingQueue } = store.get();
  const pendingIds = new Set(pendingQueue.map((q) => q.taskId));

  const taskHtml = items
    .map((item) => {
      const completedClass = item.completed ? 'completed' : '';
      const pendingClass = pendingIds.has(item.id) ? 'pending-send' : '';
      const checkmark = item.completed ? '&#x2713;' : '';
      return `
        <li class="task-item ${completedClass} ${pendingClass}" data-task-id="${item.id}">
          <div class="task-checkbox">${checkmark}</div>
          <span class="task-text">${escapeHtml(item.text)}</span>
        </li>
      `;
    })
    .join('');

  container.innerHTML = `
    <h2>Today's Quests</h2>
    <ul class="task-list" id="taskList">${taskHtml}</ul>
  `;

  // Attach click handlers
  const taskList = document.getElementById('taskList');
  taskList?.addEventListener('click', handleTaskClick);
}

function handleTaskClick(e) {
  const taskItem = e.target.closest('.task-item');
  if (!taskItem) return;

  const taskId = parseInt(taskItem.dataset.taskId, 10);
  const { tasks } = store.get();
  const item = tasks.items.find((t) => t.id === taskId);

  if (!item || item.completed) return;

  completeTask(taskId, item.text);
}

function completeTask(taskId, text) {
  const { tasks } = store.get();

  // Optimistic update
  const updatedItems = tasks.items.map((item) =>
    item.id === taskId ? { ...item, completed: true } : item,
  );
  store.update('tasks', { ...tasks, items: updatedItems });

  // Animate the item
  const el = document.querySelector(`[data-task-id="${taskId}"]`);
  if (el) {
    el.classList.add('completed', 'just-completed');
    el.querySelector('.task-checkbox').innerHTML = '&#x2713;';
    setTimeout(() => el.classList.remove('just-completed'), 400);
  }

  // Send to agent
  const message = `Task ${taskId} completed: ${text}`;
  const idempotencyKey = crypto.randomUUID();

  if (gateway.isConnected) {
    gateway
      .sendMessage(message)
      .then((res) => {
        // Response may include updated stats - listen for events
      })
      .catch(() => {
        showToast('Queued - will send when connected', 'error');
        store.enqueue({ taskId, text: message, idempotencyKey });
      });
  } else {
    store.enqueue({ taskId, text: message, idempotencyKey });
    showToast('Saved offline - will sync when connected', 'error');
  }
}

function setupConnectionListener() {
  unsubConnection?.();
  unsubConnection = store.subscribe((state) => {
    updateStatusDot();

    if (state.connection.state === 'CONNECTED') {
      fetchTasks();
    }
  });
}

function setupEventListener() {
  unsubEvents?.();

  // Listen for chat events (streamed responses)
  unsubEvents = gateway.on('*', (frame) => {
    if (frame.event === 'chat.delta') {
      accumulator.append(frame.data?.delta || '');
    } else if (frame.event === 'chat.done' || frame.event === 'chat.complete') {
      const parsed = accumulator.parse();
      if (parsed) {
        applyParsedTasks(parsed);
      } else {
        // Couldn't parse - store raw message
        const { tasks } = store.get();
        store.update('tasks', { ...tasks, rawMessage: accumulator.text });
        renderFromState();
      }
      accumulator.reset();
    }
  });

  // Also listen for connected event to fetch tasks
  gateway.on('connected', () => {
    fetchTasks();
  });
}

function fetchTasks() {
  accumulator.reset();
  gateway.sendMessage("Show today's tasks").catch((err) => {
    showToast(`Failed to fetch tasks: ${err.message}`, 'error');
  });
}

function applyParsedTasks(parsed) {
  const { tasks } = store.get();
  const update = { ...tasks };

  if (parsed.day != null) update.day = parsed.day;
  if (parsed.stats) update.stats = { ...update.stats, ...parsed.stats };
  if (parsed.items.length > 0) update.items = parsed.items;
  update.rawMessage = null;

  store.update('tasks', update);
  renderFromState();
}

function updateStatusDot() {
  const dot = document.getElementById('statusDot');
  if (!dot) return;

  const { connection } = store.get();
  dot.className = 'status-dot';

  switch (connection.state) {
    case 'CONNECTED':
      dot.classList.add('connected');
      dot.title = 'Connected';
      break;
    case 'CONNECTING':
      dot.classList.add('connecting');
      dot.title = 'Connecting...';
      break;
    case 'RECONNECTING':
      dot.classList.add('reconnecting');
      dot.title = `Reconnecting... ${connection.error || ''}`;
      break;
    default:
      dot.title = connection.error || 'Disconnected';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
