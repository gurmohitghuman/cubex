// "Paste a cURL command": the parser (server/src/lib/curl/) against real
// commands from browsers' "Copy as cURL" (Chrome bash and cmd, Firefox, Edge),
// API docs (OpenAI, GitHub, Stripe, Twilio, SendGrid) and Windows cmd and
// PowerShell docs. The commands are kept as their sources print them. Pure: no DB.
// Option forms, quoting edge cases and refusals: curl-parse-options.test.ts.
import { STRIPE_DOCS_KEY, finish, parses } from './curl-test-kit';

// ---- Browsers -------------------------------------------------------------

parses('Chrome bash (2026): --url first, $\'…\', -b, empty header, escaped [ ]', String.raw`curl --url 'https://api.example.com/v1/items?filter\[name\]=a%20b' \
  -H 'accept: application/json' \
  -H 'authorization: Bearer abc.def' \
  -H 'content-type: application/json' \
  -b 'sid=123; theme=dark' \
  -H 'x-empty;' \
  --data-raw $'{"note":"it\'s ok\u0021\nline2","path":"C:\\\\tmp","emoji":"é"}'`, {
  method: 'POST',
  url: 'https://api.example.com/v1/items?filter[name]=a%20b',
  headers: {
    accept: 'application/json', authorization: 'Bearer abc.def', 'content-type': 'application/json',
    'x-empty': '', Cookie: 'sid=123; theme=dark',
  },
  body: '{"note":"it\'s ok!\nline2","path":"C:\\\\tmp","emoji":"é"}',
  notes: [],
});

parses('Chrome bash (pre-2024): browser-only headers left out, --compressed ignored', String.raw`curl 'https://www.example.com/api/search?q=test' \
  -H 'authority: www.example.com' \
  -H 'accept: */*' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'cookie: _ga=GA1.2.1424920226.1419478126; session=eyJyZWNlbnQiOlsiMTlwd3g5NzEiXX0' \
  -H 'sec-ch-ua: "Chromium";v="118"' \
  -H 'sec-fetch-mode: cors' \
  -H 'user-agent: Mozilla/5.0' \
  --compressed`, {
  method: 'GET',
  url: 'https://www.example.com/api/search?q=test',
  headers: {
    accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
    cookie: '_ga=GA1.2.1424920226.1419478126; session=eyJyZWNlbnQiOlsiMTlwd3g5NzEiXX0', 'user-agent': 'Mozilla/5.0',
  },
  notes: ['Left out headers that browsers and curl add on their own: authority, sec-ch-ua, sec-fetch-mode.'],
});

parses('Chrome cmd (2026): ^"…^", ^-escapes, ^%, doubled backslashes', String.raw`curl --url ^"https://api.example.com/v1/items?filter^\[name^\]=a^%^20b^" ^
  -H ^"content-type: application/json^" ^
  -b ^"sid=123; theme=dark^" ^
  --data-raw ^"^{^\^"email^\^":^\^"a^@b.com^\^",^\^"pct^\^":^\^"100^%^\^",^\^"q^\^":^\^"x^&y^\^",^\^"p^\^":^\^"C:^\^\^\^\tmp^\^"^}^"`, {
  method: 'POST',
  url: 'https://api.example.com/v1/items?filter[name]=a%20b',
  headers: { 'content-type': 'application/json', Cookie: 'sid=123; theme=dark' },
  body: '{"email":"a@b.com","pct":"100%","q":"x&y","p":"C:\\\\tmp"}',
});

parses('Chrome cmd: a line break inside a value (^ + two line breaks)', 'curl ^"https://e.com/x^" ^\n  --data-raw ^"a^\n\nb^"', {
  body: 'a\nb',
});

parses('Edge cmd: quotes doubled inside "…"', String.raw`curl "https://x.example/api" --data-raw "{""lkcId"":""xx"",""isShowHideLabel"":0}"`, {
  method: 'POST',
  body: '{"lkcId":"xx","isShowHideLabel":0}',
});

parses('Firefox: --compressed, -X POST, implied form Content-Type', String.raw`curl 'https://cwip-shaka-proxy.appspot.com/no_auth' --compressed -X POST -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/127.0' -H 'Accept: */*' -H 'Origin: https://bitmovin.com' --data-raw "DATA"`, {
  method: 'POST',
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/127.0', Accept: '*/*',
    Origin: 'https://bitmovin.com', 'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'DATA',
});

parses('Firefox: $\'…\' with \\xe9 (one byte = é) and \\041', String.raw`curl 'https://example.com/api' -X POST -H 'Content-Type: application/json' --data-raw $'{"name":"Jos\xe9","note":"Hi\041"}'`, {
  body: '{"name":"José","note":"Hi!"}',
});

parses('bash $\'…\': \\xc3\\xa9 is UTF-8, \\ud83d\\ude00 a surrogate pair, \\t a tab', String.raw`curl https://e.com -d $'caf\xc3\xa9 \ud83d\ude00\tend'`, {
  body: 'café \u{1F600}\tend',
});

// ---- API docs ---------------------------------------------------------------

parses('OpenAI docs: $OPENAI_API_KEY, multi-line JSON body', String.raw`curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "input": "Tell me a three sentence bedtime story about a unicorn."
  }'`, {
  method: 'POST',
  url: 'https://api.openai.com/v1/responses',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{OPENAI_API_KEY}}' },
  body: '{\n    "model": "gpt-4.1",\n    "input": "Tell me a three sentence bedtime story about a unicorn."\n  }',
  variables: ['OPENAI_API_KEY'],
  notes: [],
});

parses('GitHub docs: the \'\\\'\' idiom, <YOUR-TOKEN>, -L', String.raw`curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <YOUR-TOKEN>" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/OWNER/REPO/issues \
  -d '{"title":"Found a bug","body":"I'\''m having a problem with this.","labels":["bug"]}'`, {
  method: 'POST',
  url: 'https://api.github.com/repos/OWNER/REPO/issues',
  headers: {
    Accept: 'application/vnd.github+json', Authorization: 'Bearer <YOUR-TOKEN>', 'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: '{"title":"Found a bug","body":"I\'m having a problem with this.","labels":["bug"]}',
  notes: ['-L was ignored', 'Content-Type: application/json was added'],
});

parses('Stripe docs: -u key: (empty password), -d plus --data-urlencode', String.raw`curl https://api.stripe.com/v1/customers \
  -u "${STRIPE_DOCS_KEY}:" \
  -d "name=Jenny Rosen" \
  --data-urlencode "email=jennyrosen@example.com"`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'name=Jenny Rosen&email=jennyrosen%40example.com',
  auth: { kind: 'basic', user: STRIPE_DOCS_KEY, password: '', from: 'user' },
  notes: [],
});

parses('Stripe docs: -G moves -d into the query string', String.raw`curl -G https://api.stripe.com/v1/customers -u "${STRIPE_DOCS_KEY}:" -d limit=3 -d "expand[]=data.default_source"`, {
  method: 'GET',
  url: 'https://api.stripe.com/v1/customers?limit=3&expand[]=data.default_source',
  headers: {},
  body: undefined,
});

parses('Twilio docs: $VARIABLES in the URL and in -u, --data-urlencode with + and spaces', String.raw`curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json" \
--data-urlencode "From=+15557122661" \
--data-urlencode "Body=Hi there" \
--data-urlencode "To=+15558675310" \
-u $TWILIO_API_KEY:$TWILIO_API_SECRET`, {
  method: 'POST',
  url: 'https://api.twilio.com/2010-04-01/Accounts/{{TWILIO_ACCOUNT_SID}}/Messages.json',
  body: 'From=%2B15557122661&Body=Hi+there&To=%2B15558675310',
  auth: { kind: 'basic', user: '{{TWILIO_API_KEY}}', password: '{{TWILIO_API_SECRET}}', from: 'user' },
  variables: ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET'],
});

parses('SendGrid docs: --request/--url/--header/--data, @ inside the body is not a file', String.raw`curl --request POST \
  --url https://api.sendgrid.com/v3/mail/send \
  --header "Authorization: Bearer $SENDGRID_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"personalizations":[{"to":[{"email":"alex@example.com"}]}],"from":{"email":"orders@example.com"},"subject":"Hi","content":[{"type":"text/plain","value":"%open-track%"}]}'`, {
  method: 'POST',
  url: 'https://api.sendgrid.com/v3/mail/send',
  headers: { Authorization: 'Bearer {{SENDGRID_API_KEY}}', 'Content-Type': 'application/json' },
  body: '{"personalizations":[{"to":[{"email":"alex@example.com"}]}],"from":{"email":"orders@example.com"},"subject":"Hi","content":[{"type":"text/plain","value":"%open-track%"}]}',
});

// ---- Windows ----------------------------------------------------------------

parses('Windows cmd docs: ^ continuations, %API_KEY%, \\" quotes', String.raw`curl -X POST "https://api.example.com/v1/items" ^
  -H "Content-Type: application/json" ^
  -H "X-API-Key: %API_KEY%" ^
  -d "{\"name\":\"Widget\",\"qty\":2}"`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': '{{API_KEY}}' },
  body: '{"name":"Widget","qty":2}',
  variables: ['API_KEY'],
});

parses('PowerShell docs: curl.exe, ` continuations, $env:API_TOKEN, \'{\\"…\\"}\'', 'curl.exe -X POST "https://api.example.com/v1/items" `\n  -H "Authorization: Bearer $env:API_TOKEN" `\n  -d \'{\\"name\\":\\"Widget\\"}\'', {
  method: 'POST',
  headers: { Authorization: 'Bearer {{API_TOKEN}}', 'Content-Type': 'application/json' },
  body: '{"name":"Widget"}',
  variables: ['API_TOKEN'],
});

parses('cmd: %20 in a URL is not a variable', 'curl "https://e.com/a%20b%E2%9C%93" ^\n  -H "Accept: */*"', {
  url: 'https://e.com/a%20b%E2%9C%93',
  variables: [],
});

finish('curl-parse');
