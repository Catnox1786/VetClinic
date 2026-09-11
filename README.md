VETCLINIC — VERSÃO SUPABASE
===========================

URL pública
----------
O site deve ser acessado em:
https://vetclinic-seven.vercel.app/#servicos

Não há referências de navegação para um endereço local neste projeto. Caso uma configuração externa ainda use um destino local, substitua-o pela URL pública acima.

Esta versão não depende mais de UwAmp, PHP ou MySQL local.
Backend utilizado:
- Supabase Auth
- PostgreSQL
- Row Level Security (RLS)
- Funções RPC para disponibilidade, vínculo de paciente e agendamento

O projeto Supabase já foi configurado pelo ChatGPT.
As tabelas criadas são:
- perfis
- pacientes
- procedimentos
- agendamentos
- historico
- vacinas
- avaliacoes

ARQUIVOS NECESSÁRIOS PARA O SITE
--------------------------------
index.html
style.css
script.js
.htaccess (somente se usar Apache)
Imagens/

NÃO SÃO MAIS NECESSÁRIOS
------------------------
api.php
config.php
security_compat.php
UwAmp
MySQL local

COMO TESTAR
-----------
Produção: abra https://vetclinic-seven.vercel.app/#servicos.

Desenvolvimento: sirva esta pasta por HTTP (por exemplo, Live Server do VS Code)
somente para testar alterações localmente; a URL pública oficial continua sendo
https://vetclinic-seven.vercel.app/#servicos.

Se a confirmação de e-mail estiver ativada no Supabase, após criar uma conta:
1. abra o e-mail de confirmação;
2. confirme a conta;
3. volte ao VetClinic e faça login.

SEGURANÇA
---------
- A chave embutida em script.js é uma chave PUBLICÁVEL do Supabase. Isso é esperado.
- Nunca coloque service_role keys no frontend.
- RLS está habilitado em todas as tabelas públicas do VetClinic.
- Tutores só conseguem consultar dados vinculados à própria conta.
- Médicos possuem acesso clínico conforme as políticas configuradas.
- A chave privada da clínica NÃO está armazenada em texto puro no site.

DADOS ANTIGOS
-------------
O ZIP VetClinic_ofc.zip recebido tinha o schema SQL, mas não continha INSERTs
com pacientes, contas, procedimentos ou outros registros antigos.
Para migrar registros que existiam no computador da escola, exporte o banco
vetclinic pelo phpMyAdmin em formato .sql e envie esse arquivo separadamente.

IMPORTANTE
----------
Faça uma cópia deste projeto antes de alterações grandes.
