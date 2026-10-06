// "Converter no servidor" na vista Cursos (etapa 7 · B4).
//
// O mapa e o catálogo são material privado: os arquivos saem do disco do
// usuário direto para o servidor (área privada), sem passar pelo repositório e
// sem ficar no navegador. O curso convertido volta pelo documento canônico
// `courses/<id>` — o MESMO envelope `groovegoblin-course` da conversão local —
// e entra na loja pelo caminho de reimportação que já existe (preserva
// progresso, anotações e vínculos).
//
// Este módulo só produz os nós de interface (botão + painel) e a chamada; quem
// os coloca na página é a composição do app.

const WARNING_LIST_MAX = 8;
const PROBLEM_LIST_MAX = 8;

function el(doc, tag, props = {}) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'hidden') node.hidden = value === true;
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
}

export function formatConvertSummary(result) {
  const counts = result?.counts ?? {};
  const parts = [];
  if (Number.isFinite(counts.sections)) parts.push(`${counts.sections} seção(ões)`);
  if (Number.isFinite(counts.lessons)) parts.push(`${counts.lessons} aula(s)`);
  if (Number.isFinite(counts.exercises)) parts.push(`${counts.exercises} exercício(s)`);
  const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0;
  const suffix = warnings > 0 ? ` · ${warnings} aviso(s) do conversor` : '';
  return `Curso convertido no servidor: ${parts.join(', ') || 'sem contagens'}${suffix}.`;
}

export function createServerConvert({
  client,
  store,
  document: doc = globalThis.document,
  notify = () => {},
  onConverted = () => {},
  download = null,
} = {}) {
  if (!client || typeof client.convert !== 'function') throw new TypeError('A conversão no servidor precisa do cliente.');
  if (!store || typeof store.importText !== 'function') throw new TypeError('A conversão no servidor precisa da loja de cursos.');

  const details = el(doc, 'details', { className: 'courses-server-import' });
  details.appendChild(el(doc, 'summary', { text: 'Converter no servidor' }));
  const panel = el(doc, 'div', { className: 'courses-server-import-panel' });
  details.appendChild(panel);

  const mapInput = el(doc, 'input', { id: 'courses-server-map', type: 'file', accept: '.json,application/json', 'aria-label': 'Mapa do curso em JSON' });
  const catalogInput = el(doc, 'input', { id: 'courses-server-catalog', type: 'file', accept: '.json,application/json', 'aria-label': 'Catálogo de exercícios em JSON (opcional)' });
  const mapLabel = el(doc, 'label', { text: 'Mapa do curso' });
  mapLabel.appendChild(mapInput);
  const catalogLabel = el(doc, 'label', { text: 'Catálogo de exercícios (opcional)' });
  catalogLabel.appendChild(catalogInput);
  const progress = el(doc, 'input', { id: 'courses-server-progress', type: 'checkbox' });
  const progressLabel = el(doc, 'label', { className: 'toggle' });
  progressLabel.append(progress, doc.createTextNode(' Incluir o progresso do mapa'));
  const status = el(doc, 'p', { className: 'courses-server-status muted', role: 'status', 'aria-live': 'polite' });
  const convertButton = el(doc, 'button', { id: 'courses-server-convert', type: 'button', className: 'primary', text: 'Converter no servidor' });
  const updateButton = el(doc, 'button', { type: 'button', text: 'Atualizar o curso existente', hidden: true });
  const hint = el(doc, 'p', { className: 'tool-hint muted', text: 'Os arquivos vão direto para a área privada do servidor; nada é publicado e nada fica guardado no repositório.' });
  panel.append(mapLabel, catalogLabel, progressLabel, hint, convertButton, updateButton, status);

  let pending = null;
  let busy = false;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.className = error ? 'courses-server-status' : 'courses-server-status muted';
  }

  async function readJson(input, label) {
    const file = input.files?.[0] ?? null;
    if (!file) return undefined;
    let text;
    try { text = await file.text(); } catch (cause) {
      throw new Error(`Não foi possível ler o ${label}: ${cause.message}.`);
    }
    try { return JSON.parse(text); } catch {
      throw new Error(`O ${label} precisa ser um JSON válido.`);
    }
  }

  function listWarnings(warnings) {
    const shown = warnings.slice(0, WARNING_LIST_MAX);
    for (const warning of shown) panel.insertBefore(el(doc, 'p', { className: 'muted', text: `${warning.path ?? 'documento'} — ${warning.message ?? warning.code ?? ''}` }), status);
    if (warnings.length > shown.length) panel.insertBefore(el(doc, 'p', { className: 'muted', text: `Mais ${warnings.length - shown.length} aviso(s).` }), status);
  }

  async function run({ expectedRev = null } = {}) {
    if (busy) return;
    busy = true;
    convertButton.disabled = true;
    updateButton.disabled = true;
    pending = null;
    try {
      let map;
      let catalog;
      try {
        map = await readJson(mapInput, 'mapa');
        catalog = await readJson(catalogInput, 'catálogo');
      } catch (error) {
        setStatus(error.message, true);
        return;
      }
      if (map === undefined && expectedRev === null) {
        setStatus('Escolha o arquivo do mapa do curso.', true);
        return;
      }
      setStatus('Convertendo no servidor…');
      const result = await client.convert({
        map,
        catalog,
        includeProgress: progress.checked === true,
        expectedRev,
      });
      if (result.ok && result.saved) {
        const document_ = await client.getDoc('courses', result.courseId);
        if (!document_.ok || !document_.body) {
          setStatus('O curso foi convertido, mas não pôde ser lido de volta do servidor.', true);
          return;
        }
        const imported = await store.importText(JSON.stringify(document_.body), { source: 'servidor' });
        if (!imported.ok) {
          setStatus(`O curso foi convertido no servidor, mas a importação local recusou: ${imported.error}`, true);
          return;
        }
        setStatus(formatConvertSummary(result));
        if (Array.isArray(result.warnings) && result.warnings.length > 0) listWarnings(result.warnings);
        updateButton.hidden = true;
        onConverted(result);
        notify(`Curso convertido no servidor e adicionado à biblioteca — ${result.courseId}.`);
        return;
      }
      if (result.status === 409) {
        // Já existe um curso com este id: só sobrescreve com a revisão atual,
        // e é o usuário que confirma.
        pending = { rev: result.rev ?? null };
        updateButton.hidden = false;
        setStatus('Já existe um curso com este id no servidor. Confirme para atualizar a estrutura (o progresso local é preservado).', true);
        return;
      }
      if (result.code === 'conversion_invalid') {
        setStatus(`O conversor recusou este mapa: ${result.message}`, true);
        for (const problem of (result.problems ?? []).slice(0, PROBLEM_LIST_MAX)) {
          panel.insertBefore(el(doc, 'p', { className: 'muted', text: `${problem.path ?? 'documento'} — ${problem.message ?? ''}` }), status);
        }
        if (Array.isArray(result.warnings) && result.warnings.length > 0) listWarnings(result.warnings);
        return;
      }
      setStatus(result.message ?? 'A conversão no servidor falhou.', true);
    } finally {
      busy = false;
      convertButton.disabled = false;
      updateButton.disabled = false;
    }
  }

  convertButton.addEventListener('click', () => { void run(); });
  updateButton.addEventListener('click', () => {
    if (!pending) return;
    const rev = pending.rev;
    pending = null;
    void run({ expectedRev: rev });
  });

  return {
    nodes: [details],
    run,
    destroy() { details.remove?.(); },
  };
}
