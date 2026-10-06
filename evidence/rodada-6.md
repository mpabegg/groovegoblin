# Rodada 6 — evidências de execução

## Etapa 1 — 128 compassos e reparos do conversor

- Fixture pública `tests/fixtures/session-128-bars.json`: 128 compassos, 128 notas e 128 acordes, sem conteúdo de curso real. Sessão v5; teto de 512 notas preservado.
- Navegador real, perfil de teste isolado: importação, troca para baixo de quatro cordas e edição da nota do compasso 128. Reprodução a 300 BPM alcançou `C128 · T1` aos 101,8 s e voltou ao início do loop.
- Treino completo de uma repetição, sem contagem, terminou em aproximadamente 102,9 s. O resultado contabilizou as 128 notas e renderizou 32 sistemas de pauta/tablatura. Nenhum ataque foi fornecido: a evidência valida a duração e os limites, não a precisão com instrumento físico.
- Exportação pelo botão real: envelope de exercício com 51.081 caracteres. Os bytes do Blob foram observados, gravados em arquivo temporário e reimportados pelo seletor real após excluir somente a fixture. A importação adicionou um exercício sem sobrescrever os demais; o documento musical reimportado foi idêntico ao exportado, com 128 notas.
- [Captura do treino em 1440 × 900](rodada-6/128-compassos-treino-1440.png).

### Conversão privada: somente contagens

A execução corrigida usou o mapa privado existente; todos os arquivos de saída e diagnósticos ficaram na área local ignorada pelo Git. Nenhum título, URL, identificador de aula, nome de material ou texto privado foi reproduzido nesta evidência.

| Medida | Resultado |
| --- | ---: |
| Seções | 22 |
| Aulas | 169 |
| IDs numéricos preservados como texto | 169 |
| Aulas assistidas | 25 |
| Materiais depois da fusão | 199 |
| Exercícios preservados | 24 |
| Materiais com compassos por acorde | 116 |
| Código de saída | 0 |

Fixtures fictícias cobrem progresso booleano/textual/objeto, identificadores numéricos, materiais duplicados com metadados complementares, alternativas de quatro e seis cordas, campos longos e agrupamento dos avisos. A revisão independente identificou e corrigiu também progresso escalar na aula e o limite de 32 nomes dentro de uma única citação composta.

### Gancho de privacidade

Três repositórios Git descartáveis executaram commits reais com o gancho instalado: PDF novo fora das fixtures, arquivo em `local/` e linha contendo termo privado fictício. Os três commits foram recusados; cada diagnóstico informou arquivo e linha, sem imprimir o termo. Sem lista de termos, continuam ativas as regras de caminhos e mídia; isso está documentado no README.

### Verificação automatizada da branch

`npm test`: 928 testes, 927 passaram, nenhum falhou e uma verificação de instrumento físico foi pulada por ausência de amostra. `npm run check`: 194 módulos, nenhuma falha. A primeira execução encontrou um teste de Repertório ainda ancorado no teto antigo; o cenário foi atualizado para 129 compassos em 7/8, sem alteração do Repertório.

## Etapa 2 — motor musical e conferência

Execução direta de `generateStudy`, com receitas inventadas:

| Cenário | Resultado observado |
| --- | --- |
| Arpejo T–3–5 em quartas, dois compassos por acorde, repetição final | 25 compassos, 37 notas, acorde final C |
| Linha contínua em quartas, casas 1–5 | 13 compassos, 49 notas, acorde final C; primeiras alturas 31, 36, 40, 43, 45, 48, 45, 41 |
| Linha de C nas casas 3–5, até fechar o período, sem compasso final | Período de três voltas; três compassos e 12 notas |
| Linha em quartas, casas 1–5, período maior que o limite | Dez voltas inteiras, 120 compassos, 480 notas; aviso `limite-128`, sem compasso final artificial |

Os 29 testes do motor/conferidor passaram. Valores esperados foram calculados a partir de exemplos pequenos, não de partituras do curso: transição estrita entre acordes, inversão de direção, percurso completo, região impossível com expansão mínima, ordem dos graus, uso da corda Si, grafia e durações.

### Catálogo privado: correspondência parcial, não transcrição

O conferidor executou sobre o catálogo local, com saída e diagnóstico guardados somente na área ignorada. Código de saída **1**, sem saída de erro: há divergências reais, não uma alegação de reprodução fiel. Os campos de observação não entram no cálculo da receita. A ordem dos graus define a figura: sua comparação é apenas informativa e não altera as contagens de sucesso, divergência ou o código de saída.

| Família | Materiais | Sem divergência nos campos conferíveis | Motivos por categoria |
| --- | ---: | ---: | --- |
| Arpejo de forma única | 105 | 96 | Compassos: 9; sem forma para conferir geometria: 105 |
| Arpejo de formas combinadas | 99 | 84 | Compassos: 9; extensão: 6; região: 6 |
| Três inversões por acorde | 2 | 0 | Cifra não reconhecida: 2 |
| Contínuo agudo–grave–agudo | 26 | 0 | Sem acordes definidos: 2; compassos: 7; cifra não reconhecida: 2; extensão: 1; ritmo: 22 |
| Contínuo grave–agudo–grave | 35 | 6 | Sem acordes definidos: 2; compassos: 9; extensão: 2; ritmo: 25; código rítmico não mapeado: 8 |
| Linha contínua de quatro notas | 68 | 30 | Sem acordes definidos: 2; compassos: 6; cifra não reconhecida: 4; ritmo: 30 |

Total: **335 materiais; 216 sem divergência nos campos conferíveis, 113 com divergência e seis não conferíveis**. Categorias podem coexistir no mesmo material. As 105 figuras de forma única ficaram sem prova de casas/cordas por falta de binding de uma forma; os 96 casos sem divergência dessa família só conferem os demais campos. As oito ocorrências agrupadas pelo script como `erro` foram diagnosticadas, sem expor entradas, como cifra não reconhecida. Foram feitas 321 comparações de compassos, 216 de cordas, 216 de extensão, 216 de região e 313 de ritmo. As 204 correspondências de ordem de graus são apenas informativas.

### Correções da revisão e verificação da branch

A revisão independente encontrou um percurso de cinco cordas que exige cinco compassos: a ação agora permite esse mínimo apenas nas famílias de percurso, sem truncar; arpejos continuam limitados a quatro compassos por acorde. A figura de arpejo em colcheias toca uma vez, com a última nota sustentada, em vez de repetir e cortar na barra. O final padrão repete o primeiro acorde. A grafia fora das quartas maiores reutiliza as tonalidades do app. O controle numérico de quantidade de formas, que não alterava o resultado, foi removido do contrato.

`npm test`: 957 testes, 956 passaram, nenhum falhou e uma amostra física ausente foi pulada. `npm run check`: 198 módulos, nenhuma falha.

## Etapa 3 — formas criadas no Braço

Navegador real isolado, 1440 × 900, somente dados fictícios:

1. **Nova forma** em baixo de quatro cordas; cliques em corda/casa `4/3`, `3/2`, `3/5` criaram G–B–D, graus 1–3–5. Um clique em `3/4` foi recusado por estar a seis semitons da tônica; as três notas válidas ficaram intactas.
2. A ordem foi alterada pelas setas para **1–5–3** e salva como “Forma de exemplo R6”. O documento da biblioteca/sessão permaneceu byte a byte igual durante essa edição: a forma ficou na loja própria.
3. Trocar para cinco cordas mostrou **“do baixo 4 cordas”**. Em C, a forma usou `5/1`, `4/0`, `4/3` na região visível 0–12. Na reprodução real, o destaque acompanhou **Cmaj7 → Fmaj7 → G7 → Cmaj7**, com três posições em cada acorde.
4. O botão real de exportação gerou um backup com a forma e a ordem 1–5–3. Após excluir somente essa fixture pelo editor e confirmar a exclusão, o mesmo arquivo foi escolhido no diálogo **Importar backup**: uma forma restaurada, exercício existente reutilizado. O bloco de formas restaurado foi idêntico ao exportado.

[Forma no baixo de quatro cordas](rodada-6/forma-baixo-1440.png) · [Reutilização no baixo de cinco cordas](rodada-6/forma-cinco-cordas-1440.png).

Nenhum erro de página foi registrado. A primeira execução automatizada encontrou uma fixture com terça musicalmente inválida, um DOM de teste que percorria nós de texto como elementos e uma expectativa incorreta sobre deduplicação; foram corrigidos nos testes, sem relaxar a validação musical. Verificação final da branch: **979 testes, 978 passaram, nenhuma falha, uma amostra física ausente pulada; 202 módulos verificados, nenhuma falha**.
