// Jogos de ouvido do GrooveGoblin (agora em Explorar). A referência de cada
// questão é gerada pelo motor (practice.js) e ouvida pelo host; a resposta é
// conferida aqui e cada rodada vira um registro "ear" no estado legado
// (groovegoblin.practice.v1) para a seção Anteriores do Percurso.
//
// O estado legado é sempre LIDO e gravado na mesma passada (updatePracticeState):
// se o Percurso limpou ou importou registros, a resposta do jogo não ressuscita
// um snapshot velho por cima do que o outro consumidor acabou de gravar.

import {
  checkRhythmAnswer,
  createEl,
  generateChordFunctionQuestion,
  generateIntervalQuestion,
  generateRhythmQuestion,
  normalizeSeed,
  previewPhrase,
  recordRun,
  renderTickGrid,
  safeStorage,
  updatePracticeState,
} from './practice.js';

export const EAR_GAMES = Object.freeze([
  { id: 'interval', name: 'Intervalos' },
  { id: 'chord', name: 'Função do acorde' },
  { id: 'rhythm', name: 'Reconhecimento de ritmo' },
]);

export function createEarGames(host, { storage = safeStorage() } = {}) {
  if (!host || typeof host !== 'object' || typeof host.play !== 'function' || typeof host.stop !== 'function') {
    throw new TypeError('Os jogos de ouvido precisam de um host do estúdio.');
  }
  let activity = 'interval';
  const games = {
    interval: { question: null, answered: null, seed: 1 },
    chord: { question: null, answered: null, seed: 1 },
    rhythm: { question: null, answered: null, marked: new Set(), seed: 1 },
  };

  function notify(text, error = false) {
    host.notify?.(text, error);
  }

  function play(notes) {
    return previewPhrase(host, notes, { bpm: 90 }).catch(error => { notify(error.message, true); return false; });
  }

  // Registro "ear" no estado legado: leitura + mutação + gravação na mesma
  // passada, sem guardar cópia em memória entre as rodadas.
  function recordEar(gameId, correct) {
    const ok = correct ? 1 : 0;
    const result = updatePracticeState(storage, state => recordRun(state, {
      id: `ear-${gameId}-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      at: new Date().toISOString(),
      kind: 'ear',
      objective: gameId,
      stage: 'ouvido',
      bpm: 90,
      bars: 1,
      durationSec: 0,
      notes: [],
      metrics: { expected: 1, matched: ok, missed: 1 - ok, extra: 0, attackOk: ok, endOk: ok, objectiveScore: ok * 100, correct: ok },
      tempoDelta: 0,
    }));
    if (!result.saved) notify('Não foi possível guardar o resultado do jogo de ouvido.', true);
    return result.value;
  }

  function seedControl(gameId, onNew) {
    const game = games[gameId];
    const wrap = createEl('div', { className: 'practice-ear-navigation' });
    const next = createEl('button', {
      type: 'button',
      className: !game.question || game.answered ? 'practice-primary' : '',
      text: game.answered ? 'Próxima questão' : game.question ? 'Trocar questão' : 'Começar',
      dataset: { focusKey: 'ear-next' },
    });
    next.addEventListener('click', () => {
      host.stop();
      game.seed = (game.seed + 1) >>> 0;
      onNew();
    });
    wrap.appendChild(next);
    const advanced = createEl('details', { className: 'practice-disclosure', dataset: { disclosure: `ear-seed-${gameId}` } });
    advanced.appendChild(createEl('summary', { text: 'Opções avançadas', dataset: { focusKey: `ear-seed-${gameId}` } }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const seedInput = createEl('input', { type: 'number', min: '0', max: '4294967295', step: '1', value: String(game.seed), 'aria-label': 'Semente do jogo de ouvido' });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Semente: ' }), seedInput]));
    const reproduce = createEl('button', { type: 'button', text: 'Gerar com esta semente' });
    reproduce.addEventListener('click', () => {
      if (typeof seedInput.reportValidity === 'function' && !seedInput.reportValidity()) return;
      host.stop();
      game.seed = normalizeSeed(seedInput.value, game.seed);
      onNew();
    });
    controls.appendChild(reproduce);
    advanced.appendChild(createEl('p', { className: 'practice-hint', text: 'Use a mesma semente para reproduzir uma questão. Próxima questão escolhe outra automaticamente.' }));
    advanced.appendChild(controls);
    wrap.appendChild(advanced);
    return wrap;
  }

  function answerButtons(question, answered, onAnswer) {
    const wrap = createEl('div', { className: 'practice-ear-answers', role: 'group', 'aria-label': 'Alternativas' });
    for (const option of question.options) {
      const isAnswer = option === question.answer;
      let className = 'practice-ear-answer';
      if (answered) {
        if (isAnswer) className += ' practice-ear-answer-correct';
        else if (answered.choice === option) className += ' practice-ear-answer-wrong';
      }
      const button = createEl('button', { type: 'button', className, text: option, disabled: !!answered, dataset: { focusKey: `ear-answer-${option}` } });
      button.addEventListener('click', () => onAnswer(option));
      wrap.appendChild(button);
    }
    return wrap;
  }

  function renderIntervalGame(onChange) {
    const game = games.interval;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de intervalos' });
    box.appendChild(createEl('h4', { text: 'Intervalos' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça duas notas e diga o intervalo entre a primeira e a segunda.' }));
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const playUp = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir referência (ascendente)' });
      playUp.addEventListener('click', () => { void play(game.question.referenceNotes); });
      controls.appendChild(playUp);
      const together = createEl('button', { type: 'button', text: 'Ouvir as duas juntas' });
      together.addEventListener('click', () => { void play(game.question.togetherNotes); });
      controls.appendChild(together);
      box.appendChild(controls);
      box.appendChild(answerButtons(game.question, game.answered, choice => {
        game.answered = { choice };
        recordEar('ear-interval', choice === game.question.answer);
        onChange();
      }));
      if (game.answered) {
        const ok = game.answered.choice === game.question.answer;
        box.appendChild(createEl('p', {
          className: 'practice-ear-feedback',
          role: 'status',
          text: ok
            ? `Correto: ${game.question.answer} (${game.question.interval.semitones} semitons).`
            : `Era ${game.question.answer} (${game.question.interval.semitones} semitons); você escolheu ${game.answered.choice}. Ouça a referência novamente para comparar.`,
        }));
      }
    }
    box.appendChild(seedControl('interval', () => { game.question = generateIntervalQuestion(game.seed); game.answered = null; onChange(); }));
    return box;
  }

  function renderChordGame(onChange) {
    const game = games.chord;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de função de acorde' });
    box.appendChild(createEl('h4', { text: 'Função do acorde' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça a tônica e depois um segundo acorde; diga a função dele.' }));
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const play = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir tônica e acorde' });
      play.addEventListener('click', () => { void play(game.question.referenceNotes); });
      controls.appendChild(play);
      box.appendChild(controls);
      box.appendChild(answerButtons(game.question, game.answered, choice => {
        game.answered = { choice };
        recordEar('ear-chord', choice === game.question.answer);
        onChange();
      }));
      if (game.answered) {
        const ok = game.answered.choice === game.question.answer;
        box.appendChild(createEl('p', {
          className: 'practice-ear-feedback',
          role: 'status',
          text: ok ? `Correto: ${game.question.answer}.` : `Era ${game.question.answer}; você escolheu ${game.answered.choice}. Ouça a referência novamente para comparar.`,
        }));
      }
    }
    box.appendChild(seedControl('chord', () => { game.question = generateChordFunctionQuestion(game.seed); game.answered = null; onChange(); }));
    return box;
  }

  function renderRhythmGame(onChange) {
    const game = games.rhythm;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de reconhecimento de ritmo' });
    box.appendChild(createEl('h4', { text: 'Reconhecimento de ritmo' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça o ritmo e marque na grade os ticks onde há ataques; depois confira.' }));
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const play = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir ritmo' });
      play.addEventListener('click', () => { void play(game.question.notes); });
      controls.appendChild(play);
      const check = createEl('button', { type: 'button', text: 'Conferir resposta', disabled: !!game.answered });
      check.addEventListener('click', () => {
        game.answered = checkRhythmAnswer(game.question, [...game.marked]);
        recordEar('ear-rhythm', game.answered.correct);
        onChange();
      });
      controls.appendChild(check);
      box.appendChild(controls);
      box.appendChild(renderTickGrid(game.answered ? game.question.notes : [], game.question.bars, game.question.ticksPerBar, {
        marked: game.answered ? new Set([...game.question.onsets]) : game.marked,
        onToggle: game.answered ? null : tick => {
          if (game.marked.has(tick)) game.marked.delete(tick);
          else game.marked.add(tick);
          onChange();
        },
        ariaLabel: 'Resposta: marque os ataques',
      }));
      if (game.answered) {
        box.appendChild(createEl('p', {
          className: 'practice-ear-feedback',
          role: 'status',
          text: game.answered.correct
            ? 'Correto: todos os ataques marcados nos ticks certos.'
            : `Quase: ${game.answered.missed.length} ataque(s) não marcado(s) e ${game.answered.extra.length} marcação(ões) extra(s). A grade agora mostra os ataques reais.`,
        }));
      }
    }
    box.appendChild(seedControl('rhythm', () => {
      game.question = generateRhythmQuestion(game.seed);
      game.marked = new Set();
      game.answered = null;
      onChange();
    }));
    return box;
  }

  // onChange: o anfitrião re-renderiza a seção (Explorar) depois de cada mudança.
  return {
    render(onChange = () => {}) {
      const section = createEl('section', { className: 'practice-section practice-ear-section', 'aria-labelledby': 'ear-games-title' });
      section.appendChild(createEl('h3', { id: 'ear-games-title', text: 'Jogos de ouvido' }));
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça, responda e confira. Cada jogo revela a resposta, sem punição; o resultado entra em Anteriores, no Percurso.' }));
      const chooser = createEl('select', { id: 'ear-games-activity', 'aria-label': 'Jogo de ouvido' });
      for (const game of EAR_GAMES) chooser.appendChild(createEl('option', { value: game.id, selected: activity === game.id, text: game.name }));
      chooser.addEventListener('change', () => { activity = chooser.value; onChange(); });
      section.appendChild(chooser);
      section.appendChild(({ interval: renderIntervalGame, chord: renderChordGame, rhythm: renderRhythmGame })[activity](onChange));
      return section;
    },
  };
}
