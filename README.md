# Oliveira Du Corte — Sistema de Agendamento

Sistema completo de agendamento online com Node.js, Express e PostgreSQL.

## Estrutura

```text
oliveira-du-corte/
├── public/
│   ├── index.html
│   └── admin.html
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── server.js
```

## Variáveis do Railway

Crie estas duas variáveis:

```text
DATABASE_URL
ADMIN_PASSWORD
```

No Railway, `DATABASE_URL` normalmente será fornecida automaticamente pelo PostgreSQL conectado ao serviço.

## Rodar localmente

```bash
npm install
npm start
```

Depois abra:

```text
http://localhost:3000
```

Painel:

```text
http://localhost:3000/admin
```

## Serviços e preços provisórios

Os valores estão no início do `server.js`, no array `SERVICES`.

Exemplo:

```js
{ id: "corte", name: "Corte", price: 30, duration: 30 }
```

Quando o barbeiro passar os valores reais, basta alterar esses dados.

## Horários provisórios

Também ficam no início do `server.js`, em `BUSINESS_HOURS`.

Atualmente:

- Segunda a sexta: 09:00–19:00
- Sábado: 09:00–17:00
- Domingo: fechado

## Segurança

O painel não expõe a senha no código. O acesso usa a variável `ADMIN_PASSWORD` do Railway.

Os agendamentos são protegidos contra conflito de horário no PostgreSQL. Dois clientes não conseguem reservar o mesmo intervalo ao mesmo tempo.

## Deploy no Railway

1. Crie um repositório no GitHub.
2. Envie todos os arquivos deste projeto.
3. No Railway, crie um projeto.
4. Conecte o repositório do GitHub.
5. Adicione um PostgreSQL ao projeto.
6. Confirme que `DATABASE_URL` está disponível no serviço da aplicação.
7. Crie `ADMIN_PASSWORD` com uma senha forte.
8. O Railway executará `npm start`.
9. Abra o domínio gerado pelo Railway.
10. Para o painel, acrescente `/admin`.

O banco é criado automaticamente na primeira inicialização do servidor.

## Fluxo final

Cliente:
Serviço → Data → Horário disponível → Nome → Telefone → Observação → Confirmar.

Barbeiro:
`/admin` → senha → lista de agendamentos → confirmar/concluir/cancelar/excluir.

O sistema não depende de WhatsApp para realizar o agendamento.
