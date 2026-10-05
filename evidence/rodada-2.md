# Rodada 2 — fluidez de edição e instrumento real

Base: `4e55281`. JavaScript ESM/CSS, sem dependências novas de runtime. Cada etapa usa branch própria, um commit, integração na main, nova execução dos testes e push. Entrada por instrumento implementada em worktree separado e integrada na etapa 6.

## Registro das etapas

As seções abaixo recebem decisões e resultados observados ao concluir cada etapa; não representam verificações antecipadas.

### Etapa 1 — Previsibilidade, mensagens e popovers

- Padrões compatíveis repetem somente as notas; geração mantém os parâmetros musicais. Incompatibilidades oferecem mudar compasso/divisão ou cancelar; não há quantização/fusão silenciosa. Expansão exige aceite e não corta acordes/seções.
- BPM sugerido só é aplicado quando não existem notas, acordes, banda ligada ou seções. Banda inicial cria um acorde por compasso.
- Toast único sobreposto: 6 s normal, 10 s com Desfazer seguro; fecha ao trocar de aba. Popovers nativos no top layer, ancorados ao acionador; avançado harmônico inline.
- Verificação na branch: `npm test` **306/306**, `npm run check` **82 módulos, zero falhas**. Navegador: Tresillo manteve 72 BPM/4 compassos/acorde no segundo compasso, três ataques em cada compasso; início em três cliques tocou quatro acordes de um compasso. Diálogo 7/8 explicou a mudança antes do aceite.
- Toast expirou; posição documental do transporte permaneceu **130 px antes/depois**. Som da bateria abriu a 6 px abaixo do acionador, inteiro no viewport, com aviso presente.
- Capturas: [1440×900](rodada-2-etapa1-1440x900.png), [1280×800](rodada-2-etapa1-1280x800.png).

## Critérios de aceitação

| Nº | Critério | Resultado |
|---|---|---|
| 1 | Tresillo preserva 4 compassos, 72 BPM e acorde no compasso 2; preenche frase | Passou: navegador e regressão |
| 2 | Banda inicial: um acorde por compasso | Passou: navegador, 4 acordes × 1 compasso; regressões incluem 1 compasso |
| 3 | Criar/mover nota e trocar acorde durante loop sem parar | Pendente |
| 4 | Cliques nas faixas têm resposta visível | Pendente |
| 5 | Duração ativa lembrada; arrasto central move nota curta | Pendente |
| 6 | Seleção múltipla, copiar, colar, duplicar e Esc | Pendente |
| 7 | Aumentar sessão e repetir frase | Pendente |
| 8 | Acordes repetidos desenhados como fantasmas | Pendente |
| 9 | 16 compassos legíveis; semicolcheia >=12px, rótulos sem sobreposição | Pendente |
| 10 | Popovers ancorados e inteiros, com e sem aviso | Parcial: Som da bateria verificado; todas as faixas na verificação final |
| 11 | Mudo e solo a um clique | Pendente |
| 12 | Avisos não deslocam transporte | Passou: posição documental 130 px antes/depois |
| 13 | Transporte em uma linha a 1280px; <=60 controles no Estúdio | Pendente |
| 14 | Arrastar régua define loop | Pendente |
| 15 | Ouvir frase no Treinar e partitura inteira | Pendente |
| 16 | Bateria editável, exportação/importação e migração v3 preservadas | Pendente |
| 17 | Captura, medidor e diagnóstico de ataques | Pendente; validação física de guitarra depende do usuário |
| 18 | Detector sintético: erro <=10ms, sem falsos ataques sustentados | Pendente |
| 19 | Instrumento usa relatório comum; duração/altura não avaliadas | Pendente |
| 20 | Calibração por dispositivo altera desvio seguinte | Pendente |
| 21 | Permissão negada/ausência retorna ao Teclado | Pendente |
| 22 | Nenhuma permissão solicitada antes de escolher Instrumento | Pendente |
| 23 | Removidas afirmações de que microfone não é usado | Pendente |
| 24 | Preservados requisitos da primeira rodada | Pendente |

## Limite de evidência de áudio

Sinais sintéticos e dispositivos simulados permitem verificar detector, relógio, medidor e integração. Não equivalem a tocar uma guitarra física. O painel de diagnóstico permitirá essa validação posterior sem gravar nem enviar áudio.
