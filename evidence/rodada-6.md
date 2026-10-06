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
