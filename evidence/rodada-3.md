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
- Integração publicada na `main`: `40d4582`; **411/411 testes e check repetidos na main**, push concluído.

### Etapa 2 — Tablatura editável

- Sessão **v5**, com `note.string` opcional (1 = corda mais aguda). Migração v2/v3/v4 valida o documento original antes de aceitar campos novos; notas antigas continuam sem atribuição armazenada e usam a posição de menor casa para exibição. Arquivos, links, biblioteca, histórico e snapshots conservam a corda.
- Ritmo/Tablatura é uma escolha por sessão. Seis linhas na guitarra, quatro/cinco no baixo; notas mantêm largura proporcional à duração. Cordas/casas/nomes no inspetor; MIDI numérico permanece em Avançado.
- No navegador, clique na terceira linha + **5** produziu **C4/MIDI 60, corda 3, duração 2**. ↑ mudou para corda 2/casa 1 sem mudar a altura; a próxima subida impossível foi recusada sem alteração. **1,2** dentro da janela produziu casa 12; **3** após 650 ms produziu casa 3, não 123.
- Shift+↑/↓ mudou duração sem mudar altura/corda; ←/→ mudou somente início; Ctrl+D preservou altura, duração e corda na cópia. Editar casa durante o loop manteve **Parar**; Desfazer recuperou a nota anterior.
- Sexta corda **E2/MIDI 40, casa 0** permaneceu idêntica no documento ao mudar para Drop D e passou a mostrar **casa 2**. Uma nota E1 fora de alcance continuou visível/editável; a ação explícita de oitava mudou apenas 28→40, mantendo ID, início e duração.
- Trocar tipo ou quantidade de cordas limpa apenas atribuições físicas obsoletas na mesma transação; manter alturas preservou todas as notas. Afinação e nomes não limpam cordas. Baixo com quatro e cinco linhas foi conferido.
- Download real v5 de **6.979 bytes**, reimportação e reload preservaram o JSON canônico inteiro, modo Tab, sexta corda e Drop D. Fixture v4 reaberta no v5 preservou notas, timbre e os **77 eventos realizados**, idênticos ao código de referência.
- A inspeção visual revelou mixer indevidamente dentro da nova linha título/vista. Corrigida sua âncora no cabeçalho: título completo, volume de **101 px**, nenhum controle fora do cabeçalho.
- Verificação final da branch: **470/470 testes**, **114 módulos**, zero falhas. Duas assertivas iniciais foram corrigidas: posição automática realmente de menor casa e resto matemático de diferença negativa de oitavas, sem mudar produção para satisfazê-las.
- Capturas: [1440×900](rodada-3-etapa2-1440x900.png), [1280×800](rodada-3-etapa2-1280x800.png): **53 controles**, transporte **53 px**, sem overflow horizontal. Tab de seis cordas termina o inspetor em **y=845**; o modo Ritmo conserva faixa de **88 px** e inspetor em **y=765**.
- Integração publicada na `main`: `a18e9c3`; **470/470 testes e check repetidos na main**, push concluído.

### Etapa 3 — Partitura, cifras e tablatura

- As duas vistas usam a pauta rítmica existente, com clave Sol/Fá 8vb, cifras por compasso e tablatura somente no modo Tab. Não foi criada uma pauta melódica nem alterada a altura sonora.
- Navegador: sessão de **16 compassos** produziu **quatro sistemas de quatro**, 16 cifras e nenhuma rolagem horizontal interna (largura/scroll de 1.364 px). Cabeças rítmicas e casas tiveram coordenadas idênticas em todos os dez segmentos, incluindo a nota ligada entre compassos 4 e 5.
- Reprodução e treino reais mostraram o cursor e o destaque atravessando a ligadura: segmento em **60**, seguido pelo segmento em **64**, no sistema seguinte. O treino usa a sessão executada, não uma edição posterior.
- Baixo mostrou clave **F8vb**, quatro linhas e depois cinco com afinação aguda→grave **43/38/33/28/23**; Guitarra mostrou **G8vb**. Palhetadas só aparecem em Guitarra/Ritmo com acordes ligados, seguem tempo/subdivisão e o botão de ocultar removeu as sugestões.
- Correções encontradas visualmente: textos SVG novos herdavam preenchimento preto; receberam contraste explícito. Numeração foi afastada das cifras. A pauta/tablatura de seis cordas exigiu compactar espaçamentos do Treinar, sem retirar controles.
- Capturas finais: [1440×900](rodada-3-etapa3-1440x900.png), [1280×800](rodada-3-etapa3-1280x800.png). Com Instrumento configurado e quatro compassos em Tab, documento de **900 px** em 1440×900 e painel completo até **y=803**, incluindo Prática guiada recolhida. Sem overflow horizontal nas duas larguras.
- Estúdio em repouso a 1280 px: **53 controles**, transporte de **53 px**. Janela longa de 16 compassos é intencionalmente distribuída em vários sistemas verticais.
- Verificação final da branch: **477/477 testes**, **115 módulos**, zero falhas.


### Etapa 7 — Entrada por instrumento

- Integrada logo após o perfil: a etapa é independente das etapas 2–6 e libera o afinador em paralelo, conforme as dependências solicitadas.
- A preferência lembra a intenção Instrumento, dispositivo e canal, mas montar/recarregar o app não consulta permissão, enumera dispositivos nem abre captura. Entrar em Treinar consulta a permissão e reabre somente quando já concedida.
- Chromium real com dispositivo simulado: **zero chamadas de captura na abertura e recarga**; na entrada em Treinar com permissão concedida, uma consulta e uma captura. Com permissão efetivamente `prompt`, **zero capturas**, botão Ativar instrumento visível; ativação explícita abriu uma captura.
- Trocar o foco para outra aba real encerrou todas as tracks, mantendo a preferência Instrumento. Canal 1 do WAV estéreo ficou silencioso; canal 2 alimentou medidor e Testar entrada. O resumo de canal agora muda imediatamente, com regressão cobrindo a falha encontrada no navegador.
- Entrada configurada ocupa uma linha de **40 px**; Configurar recolhe dispositivo, canal, sensibilidade, calibração e avisos. Quatro compassos em **1440×900**: documento de **900 px**, painel principal termina em **y=704,47**, sem rolagem vertical. O botão Afinador será integrado na etapa 8, sem controle fictício nesta etapa.
- Interruptores de faixas disponíveis compõem mute/volume/solo sem modificar a sessão. Durante treino real, o bus de metrônomo foi observado em **1 → 0 → 1**, mantendo a posição **C1/T1/repetição 1/2** e os estados pressionados correspondentes.
- Detector grave separado do ajuste de guitarra: origem observada da subida, memória de picos entre ciclos e término dessa memória após silêncio sustentado. Um caso de reataque após golpe rejeitado pelo refratário falhou inicialmente; a correção mantém as mesmas assertivas.
- Testes sintéticos: **30,87/41,2/55/98 Hz**, subida de **15 ms**, sinais sustentados/repetidos, fases, ruído e blocos distintos em **8/44,1/48/96 kHz**, dentro de **10 ms** e sem ataques extras. No WAV usado pelo navegador, com fundamental fraca e segundo/terceiro harmônicos, os quatro graves tiveram erro puro de **0,042–0,063 ms**.
- Verificação da branch: **450/450 testes**, **111 módulos**, zero falhas; `main.js` tem **529 linhas**, abaixo das 536 iniciais. Estúdio com quatro faixas: **52 controles medidos**, transporte de **53 px** em 1280 px.
- Capturas: [1440×900](rodada-3-etapa7-1440x900.png), [1280×800](rodada-3-etapa7-1280x800.png). Nenhum erro da aplicação registrado pelo navegador.
- Integração publicada na `main`: `b1cc204`; **450/450 testes e check repetidos na main**, push concluído.

## Critérios de aceitação

| Nº | Critério | Resultado |
|---|---|---|
| 1 | Perfil visível; Baixo muda nome, timbre, acompanhamento, tablatura e clave | Passou: perfil/som e linhas 6/4/5; claves desenhadas G8vb/F8vb verificadas no navegador |
| 2 | Perfil, cordas e afinação preservados em arquivo e reload | Passou: download, importação e reload com Baixo 5/Drop D/solfejo |
| 3 | Sessão v4 antiga abre e soa igual | Passou após v5: 77 eventos realizados idênticos à referência v4, sem mudar notas/timbre/papel |
| 4 | Terceira corda + casa 5 produz altura correta | Passou no navegador: corda 3/casa 5 → C4/MIDI 60 |
| 5 | Troca de corda preserva altura; Drop D atualiza casas | Passou: C4 muda de corda sem transpor; E2 na sexta vira casa 2 em Drop D |
| 6 | Cifras, ritmo e tablatura alinhados em sistemas de quatro compassos nas duas vistas | Passou: quatro sistemas numa sessão de 16 compassos, alinhamento exato e cursor/ligadura em reprodução e treino |
| 7 | Linha Rock sobre C–F–G–C vira frase editável no registro do baixo | Pendente |
| 8 | Estudar esta linha copia baixo e troca perfil | Pendente |
| 9 | Braço mostra funções do acorde selecionado e acompanha reprodução | Pendente |
| 10 | Desenhos tocáveis para C, G, D, Am, Em, F e B7 | Pendente |
| 11 | Blues ocupa 12 compassos; oferece ajuste quando a sessão tem quatro | Pendente |
| 12 | Filtro Ritmo/Guitarra/Baixo; padrões de baixo seguem harmonia | Pendente |
| 13 | Contagem de um compasso antes de Tocar | Pendente |
| 14 | Acelerador +5 a cada duas voltas; BPM salvo permanece intacto | Pendente |
| 15 | Afinador de 30,87 a 1318,5 Hz: erro até 5 cents e corda correta | Pendente |
| 16 | Entrada lembrada ativa ao entrar em Treinar somente com permissão concedida | Passou: startup sem captura; granted automático; prompt sem captura; explícito abre; foco encerra |
| 17 | Treinar com entrada configurada e quatro compassos cabe em 1440×900 | Passou após partitura Tab de seis cordas: documento 900 px e painel completo até y=803; repetir após afinador |
| 18 | Ataques graves com subida de 15 ms: erro até 10 ms e nenhuma repetição falsa em sustentadas | Passou: quatro frequências × quatro taxas, reataques/sustentadas/ruído; WAV harmônico também exercitado |
| 19 | Alturas sintéticas: certas, nota errada, oitava diferente e não identificada | Pendente |
| 20 | Miniatura revela conteúdo além de quatro compassos e navega ao clique | Pendente |
| 21 | Até 62 controles em repouso; transporte em uma linha a 1280 px | Passou até etapa 2: 53 controles/53 px; verificar novamente ao final |
| 22 | Funcionalidades aprovadas da rodada 2 preservadas | Pendente |

## Limite de verificação de áudio

Não há guitarra nem baixo físicos disponíveis nesta execução. Detector, afinador e avaliação de alturas serão exercitados com sinais sintéticos e captura real do navegador alimentada por dispositivo simulado. Esses resultados não equivalem a tocar um instrumento físico. Testar entrada e Afinador permanecem disponíveis para a validação do usuário; áudio de entrada não é gravado nem enviado.
