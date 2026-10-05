# Rodada 3 — estúdio de prática para guitarra e baixo

Base: `6b00ee0`, sessão v4; referência informada de 402 testes aprovados. JavaScript ESM/CSS, sem dependências novas de runtime e sem build obrigatório. Uma branch e um commit por etapa, testes/check antes da integração, repetição na main e push. A entrada de áudio é desenvolvida em worktree separado e integrada na etapa 7.

## Registro das etapas

As seções abaixo registram resultados observados, não verificações antecipadas. Foram lidos os módulos exigidos antes das alterações: evidências da rodada 2, página, todos os módulos `studio*`, sessão, modelo, banda, progressão, notação, entrada e módulos `instrument-*`.

### Etapa 1 — Perfil de instrumento

- Perfil salvo em `extensions.studio.instrument`, ainda na sessão v4: tipo, número de cordas, afinação MIDI soante da grave à aguda e preferência de nomes. Seletor no transporte; cordas, afinação e nomes ficam no popover.
- Ausência de perfil resolve visualmente para Guitarra/letras, sem inserir o campo nem alterar o som legado. Preferência própria só inicia uma sessão genuinamente nova; importação, recovery e histórico não a aplicam sobre documentos existentes. `band.role` legado permanece preservado, embora seu controle antigo tenha sido removido.
- Decisões: Drop D no baixo de cinco cordas preserva B0 e baixa E1 para D1; transposição explícita entre perfis usa duas oitavas inteiras, sem alterar intervalos nem limitar alturas silenciosamente. Afinação personalizada é informada por nota e oitava, não por um número técnico na vista padrão.
- Navegador: importar fixture v4 preservou alturas **69/48/76/28**, marimba e papel legado `bass`; os eventos realizados dos quatro compassos foram **idênticos** à referência anterior (20/20/19/18 eventos). Cancelar a troca preservou o JSON byte a byte.
- Manter alturas ao escolher Baixo mudou o nome para **Baixo (meu)**, timbre para baixo elétrico, desligou o baixo gerado e expôs metadados de clave Fá 8vb. Tablatura e desenho da clave são verificados nas etapas 2–3.
- Baixo de cinco cordas em Drop D, com nomes em solfejo, foi exportado pelo download real (**6.077 bytes**), reimportado pelo campo de arquivo e recarregado: preservou **[23,26,33,38,43]** e a preferência. Nova sessão herdou esse perfil; nota criada em E1 foi transposta para E3 ao escolher Guitarra.
- Novos timbres têm síntese real. OfflineAudioContext do Chromium: picos de **0,4985** (guitarra limpa), **0,4679** (abafada) e **0,6850** (baixo elétrico). Entre 200–350 ms, RMS da limpa foi **0,2310**, contra **0** da abafada, verificando o decaimento distinto.
- `main.js` passou de **536 para 519 linhas**, extraindo a composição de sessão. Verificação: **411/411 testes**, **110 módulos**, zero falhas.
- Capturas: [1440×900](rodada-3-etapa1-1440x900.png), [1280×800](rodada-3-etapa1-1280x800.png). Quatro faixas ligadas: **51 controles**, transporte de **53 px** e inspetor até **y=765**, sem overflow horizontal.

## Critérios de aceitação

| Nº | Critério | Resultado |
|---|---|---|
| 1 | Perfil visível; Baixo muda nome, timbre, acompanhamento, tablatura e clave | Parcial: perfil/nome/timbre/acompanhamento passaram; tablatura/clave visual nas etapas 2–3 |
| 2 | Perfil, cordas e afinação preservados em arquivo e reload | Passou: download, importação e reload com Baixo 5/Drop D/solfejo |
| 3 | Sessão v4 antiga abre e soa igual | Passou na etapa 1: importação e eventos realizados idênticos; repetir após migração v5 |
| 4 | Terceira corda + casa 5 produz altura correta | Pendente |
| 5 | Troca de corda preserva altura; Drop D atualiza casas | Pendente |
| 6 | Cifras, ritmo e tablatura alinhados em sistemas de quatro compassos nas duas vistas | Pendente |
| 7 | Linha Rock sobre C–F–G–C vira frase editável no registro do baixo | Pendente |
| 8 | Estudar esta linha copia baixo e troca perfil | Pendente |
| 9 | Braço mostra funções do acorde selecionado e acompanha reprodução | Pendente |
| 10 | Desenhos tocáveis para C, G, D, Am, Em, F e B7 | Pendente |
| 11 | Blues ocupa 12 compassos; oferece ajuste quando a sessão tem quatro | Pendente |
| 12 | Filtro Ritmo/Guitarra/Baixo; padrões de baixo seguem harmonia | Pendente |
| 13 | Contagem de um compasso antes de Tocar | Pendente |
| 14 | Acelerador +5 a cada duas voltas; BPM salvo permanece intacto | Pendente |
| 15 | Afinador de 30,87 a 1318,5 Hz: erro até 5 cents e corda correta | Pendente |
| 16 | Entrada lembrada ativa ao entrar em Treinar somente com permissão concedida | Pendente |
| 17 | Treinar com entrada configurada e quatro compassos cabe em 1440×900 | Pendente |
| 18 | Ataques graves com subida de 15 ms: erro até 10 ms e nenhuma repetição falsa em sustentadas | Pendente |
| 19 | Alturas sintéticas: certas, nota errada, oitava diferente e não identificada | Pendente |
| 20 | Miniatura revela conteúdo além de quatro compassos e navega ao clique | Pendente |
| 21 | Até 62 controles em repouso; transporte em uma linha a 1280 px | Passou na etapa 1: 51 controles/53 px; verificar novamente ao final |
| 22 | Funcionalidades aprovadas da rodada 2 preservadas | Pendente |

## Limite de verificação de áudio

Não há guitarra nem baixo físicos disponíveis nesta execução. Detector, afinador e avaliação de alturas serão exercitados com sinais sintéticos e captura real do navegador alimentada por dispositivo simulado. Esses resultados não equivalem a tocar um instrumento físico. Testar entrada e Afinador permanecem disponíveis para a validação do usuário; áudio de entrada não é gravado nem enviado.
