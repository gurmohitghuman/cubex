// "Paste a cURL command": curl's option forms and quoting edge cases
// (curlconverter's quoting torture test, Insomnia's short-option cases, pasted
// docs that lost their line endings) and every command the parser refuses, with
// why. Pure: no DB. Real browser and docs commands: curl-parse.test.ts.
import assert from 'node:assert/strict';
import { parseCurl } from '../../server/src/lib/curl/parse';
import { finish, parses, ran, refuses } from './curl-test-kit';

// ---- Quoting and option forms ----------------------------------------------

parses('curlconverter\'s quotes-anywhere test', String.raw`curl 'http://localhost:28139' \
    -d "a=b&c=\"&d='" \
    -u "ol':asd\"" \
    -H "A: ''a'" \
    -H 'B: "' \
    -H "Cookie: x=1'; y=2\""`, {
  url: 'http://localhost:28139',
  headers: { A: "''a'", B: '"', Cookie: 'x=1\'; y=2"', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'a=b&c="&d=\'',
  auth: { kind: 'basic', user: "ol'", password: 'asd"', from: 'user' },
});

parses('Insomnia: -XPOST -did=1234 (attached values)', 'curl -XPOST -did=1234 https://insomnia.rest', {
  method: 'POST', url: 'https://insomnia.rest', body: 'id=1234',
});

parses('Insomnia: \\? outside quotes, JSON body without Content-Type', String.raw`curl http://192.168.1.1:9200/executions/_search\?pretty --data '{"query":{"match_all":{}}}'`, {
  url: 'http://192.168.1.1:9200/executions/_search?pretty',
  headers: { 'Content-Type': 'application/json' },
  body: '{"query":{"match_all":{}}}',
  notes: ['Content-Type: application/json was added'],
});

parses('Insomnia: a header value with colons', "curl https://insomnia.rest -H 'X-Something: foo: bar:baz'", {
  headers: { 'X-Something': 'foo: bar:baz' },
});

parses('Insomnia: --user split on the first colon, --cookie, trailing ;', String.raw`curl --request POST --url http://localhost:8000/api/v1/send --user 'My User:My:Secret:Password' --cookie NID=91=iOf1sU9Ovlns9Dzn2Ipz05 --data '{"email_id": "tem_123"}';`, {
  url: 'http://localhost:8000/api/v1/send',
  headers: { Cookie: 'NID=91=iOf1sU9Ovlns9Dzn2Ipz05', 'Content-Type': 'application/json' },
  auth: { kind: 'basic', user: 'My User', password: 'My:Secret:Password', from: 'user' },
  body: '{"email_id": "tem_123"}',
});

parses('--opt=value (curl 8.16)', "curl --request=PUT --header='X-Y: z' --data='a=1' https://e.com/x", {
  method: 'PUT', headers: { 'X-Y': 'z', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1',
});

parses('combined short flags with a value at the end: -sSLd', "curl -sSLd 'a=1' https://e.com", { method: 'POST', body: 'a=1' });
parses('attached header: -H\'X: y\'', "curl -H'X-Y: z' https://e.com", { headers: { 'X-Y': 'z' } });
parses('-X get is GET', 'curl -X get https://e.com', { method: 'GET' });
parses('several -d join with &', 'curl -d a=1 -d b=2 https://e.com', { body: 'a=1&b=2' });
parses('--json sets Content-Type and Accept', "curl --json '{\"a\":1}' https://e.com", {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{"a":1}',
});
parses('-H \'Accept:\' stops --json\'s Accept', "curl --json '{}' -H 'Accept:' https://e.com", {
  headers: { 'Content-Type': 'application/json' },
});
parses('repeated headers join', "curl -H 'X-A: 1' -H 'x-a: 2' https://e.com", {
  headers: { 'X-A': '1, 2' }, notes: ['repeated'],
});
parses('an explicit Authorization header beats -u', "curl -u a:b -H 'Authorization: Bearer t' https://e.com", {
  auth: undefined, headers: { Authorization: 'Bearer t' }, notes: ['-u was ignored'],
});
parses('user:password@ in the URL is Basic sign-in', 'curl https://bob:p%40ss@api.example.com/x', {
  url: 'https://api.example.com/x', auth: { kind: 'basic', user: 'bob', password: 'p@ss', from: 'url' },
});
parses('-u with no password', 'curl -u bob https://e.com', {
  auth: { kind: 'basic', user: 'bob', password: '', from: 'user' }, notes: ['-u had no password'],
});
parses('--oauth2-bearer', 'curl --oauth2-bearer tok123 https://e.com', { auth: { kind: 'bearer', token: 'tok123' } });
parses('-A and -e', "curl -A 'Agent/1' -e 'https://ref.example/;auto' https://e.com", {
  headers: { 'User-Agent': 'Agent/1', Referer: 'https://ref.example/' },
});
parses('--url-query', "curl --url-query 'q=a b' --url-query '+raw=x y' https://e.com/s", { url: 'https://e.com/s?q=a+b&raw=x y' });
parses('a URL with no scheme gets https://', 'curl api.example.com/v1/me', {
  url: 'https://api.example.com/v1/me', notes: ['https:// was added'],
});
parses('a #fragment is not sent', "curl 'https://e.com/x?a=1#frag'", { url: 'https://e.com/x?a=1' });
parses('a {{# Revenue}} reference is not a fragment', "curl 'https://e.com/x?n={{# Revenue}}'", { url: 'https://e.com/x?n={{# Revenue}}' });
parses('${BASE_URL} at the start of the URL', 'curl "${BASE_URL}/v1/x"', { url: '{{BASE_URL}}/v1/x', variables: ['BASE_URL'] });
parses('unquoted & in a URL', 'curl https://e.com/x?a=1&b=2', { url: 'https://e.com/x?a=1&b=2' });
parses('| jq is ignored', 'curl -s https://api.github.com/users/octocat | jq .login', {
  url: 'https://api.github.com/users/octocat', notes: ['Only the curl command was used'],
});
parses('2>&1 redirect', 'curl https://e.com/x 2>&1', { url: 'https://e.com/x' });
parses('a $ prompt in front', '$ curl https://e.com/x', { url: 'https://e.com/x' });
parses('env assignment before curl', 'TOKEN=abc curl https://e.com/x', { url: 'https://e.com/x' });
parses('lines without backslashes (docs that lost them)', "curl https://api.example.com/v1/x\n  -H 'Accept: application/json'\n  -d 'a=1'", {
  method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1',
});
parses('backslash with trailing spaces still continues the line', "curl https://e.com/x \\   \n  -H 'A: b'", { headers: { A: 'b' } });
parses('curly quotes from a chat app', 'curl \u201chttps://e.com/x\u201d -H \u201cAccept: application/json\u201d', {
  url: 'https://e.com/x', headers: { Accept: 'application/json' }, notes: ['Curly quotes'],
});
parses('a no-break space between arguments', 'curl\u00a0https://e.com/x\u00a0-H\u00a0\'A: b\'', { headers: { A: 'b' } });
parses('-k, -L and -x are noted', 'curl -k -L -x http://proxy:8080 https://e.com/x', {
  notes: ['-k was ignored', '-L was ignored', 'proxy setting was ignored'],
});
parses('-H "Name" with no colon is not sent', "curl -H 'Bearer abc' https://e.com/x", {
  headers: {}, notes: ['without a colon'],
});
parses('Host, Content-Length, Connection and Accept-Encoding are left out', "curl -H 'Host: e.com' -H 'Content-Length: 3' -H 'Connection: keep-alive' -H 'Accept-Encoding: gzip, br' https://e.com/x", {
  headers: {}, notes: ['host, content-length, connection, accept-encoding'],
});
parses('a {{column}} survives', "curl 'https://api.example.com/lookup?domain={{Domain}}' -H 'X-Key: {{apollo}}'", {
  url: 'https://api.example.com/lookup?domain={{Domain}}', headers: { 'X-Key': '{{apollo}}' }, variables: [],
});

// ---- From the review: URLs with an @ in the password, slow inputs, forged markers,
// bash that looks like Windows, repeated single-value headers

parses('user:password@ ends at the last @ (a password may hold one)', 'curl https://me@example.com:Pass@word123@api.host.com/v1', {
  url: 'https://api.host.com/v1', auth: { kind: 'basic', user: 'me@example.com', password: 'Pass@word123', from: 'url' },
});
parses('an @ in the query is not sign-in', "curl 'https://api.x.com/v1?email=a@b.com'", {
  url: 'https://api.x.com/v1?email=a@b.com', auth: undefined,
});
ran('a run of 99,000 "{" parses in well under a second (URL and body)', () => {
  for (const cmd of [`curl 'https://e.com/${'{'.repeat(99_000)}'`, `curl https://e.com -d '${'{{a'.repeat(33_000)}'`]) {
    const t = Date.now();
    try { parseCurl(cmd) } catch { /* refusing is fine; only the time matters */ }
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  }
});
// A $'...' escape can't make a variable marker, and neither can the marker characters pasted as they are.
const U = '\\' + 'u'
parses("$'" + U + "E000...' can't forge a variable", `curl https://e.com -H $'X-A: ${U}E000OPENAI${U}E001'`, {
  headers: { 'X-A': 'OPENAI' }, variables: [],
});
parses('pasted marker characters are dropped', `curl https://e.com -H 'X-A: ${String.fromCharCode(0xe000)}OPENAI${String.fromCharCode(0xe001)}'`, {
  headers: { 'X-A': 'OPENAI' }, variables: [],
});
parses('bash JSON with an empty key stays bash', `curl https://api.x.com/v1 -H 'Content-Type:application/json' -d '{"":"x","k":"v"}'`, {
  headers: { 'Content-Type': 'application/json' }, body: '{"":"x","k":"v"}',
});
parses('a markdown fence in a bash body stays bash', "curl https://e.com -d 'see:\n```\ncode\n```'", {
  body: 'see:\n```\ncode\n```',
});
parses('a repeated Content-Type: the last one is sent', "curl https://e.com -H 'Content-Type: text/plain' -H 'Content-Type: application/json' -d '{}'", {
  headers: { 'Content-Type': 'application/json' }, notes: ['Only the last Content-Type header was kept.'],
});
parses('--oauth2-bearer beaten by an Authorization header says so', "curl --oauth2-bearer t1234 -H 'Authorization: Bearer x' https://e.com", {
  auth: undefined, notes: ['--oauth2-bearer was ignored'],
});

parses('one ^" inside a bash body is not Windows syntax', `curl https://e.com -d 'q= ^"abc'`, { body: 'q= ^"abc' });

// ---- Refusals ----------------------------------------------------------------

refuses('-F forms', "curl -F 'file=@a.png' https://e.com", 'Forms and file uploads');
refuses('-d @file', 'curl -d @body.json https://e.com', 'reads a file');
refuses('--data-binary @-', 'curl --data-binary @- https://e.com', 'reads a file');
refuses('--data-urlencode name@file', 'curl --data-urlencode msg@file.txt https://e.com', 'reads a file');
refuses('-H @file', 'curl -H @headers.txt https://e.com', '-H @file');
refuses('-T upload', 'curl -T a.txt https://e.com', 'Uploading a file');
refuses('-K config', 'curl -K cfg.txt https://e.com', '-K reads options');
refuses('-I HEAD', 'curl -I https://e.com', 'HEAD requests');
refuses('PATCH', 'curl -X PATCH https://e.com', "PATCH requests aren't supported");
refuses('GET with a body', "curl -X GET -d '{}' https://e.com", 'body with GET');
refuses('two URLs', 'curl https://a.com https://b.com', 'calls 2 URLs');
refuses('$(…)', 'curl -H "Authorization: Bearer $(cat key)" https://e.com', 'runs another command');
refuses('backticks', 'curl -H "Authorization: Bearer `cat key`" https://e.com', 'runs another command');
refuses('PowerShell $(…)', 'curl.exe -H "X: $(Get-Key)" `\n https://e.com', 'runs another command');
refuses('--aws-sigv4', "curl --aws-sigv4 'aws:amz:us-east-1:s3' -u a:b https://e.com", 'AWS request signing');
refuses('--digest', 'curl --digest -u a:b https://e.com', 'Digest');
refuses('-E certificate', 'curl -E cert.pem https://e.com', 'Client certificates');
refuses('--variable', 'curl --variable %HOME https://e.com', 'curl variables');
refuses('--expand-url', 'curl --expand-url https://e.com/{{x}}', 'curl variables');
refuses('-: (--next)', 'curl https://a.com -: https://b.com', 'more than one request');
refuses('an unknown option', 'curl --frobnicate https://e.com', "--frobnicate isn't a curl option");
refuses('an unknown short option', 'curl -W https://e.com', "-W isn't a curl option");
refuses('a flag given a value', 'curl --silent=yes https://e.com', "doesn't take a value");
refuses('an option missing its value', 'curl https://e.com -H', '-H needs a value');
refuses('ftp://', 'curl ftp://files.example.com/a.txt', 'Only http:// and https://');
refuses('not curl', 'wget https://e.com', "doesn't look like a cURL command");
refuses('empty', '   ', 'Paste a cURL command');
refuses('an unclosed quote', "curl 'https://e.com", "quote isn't closed");
refuses('Invoke-WebRequest', 'curl -Uri https://e.com -Method POST', 'Invoke-WebRequest');
refuses('no URL', 'curl -s', 'no URL');
refuses('a header name with a space', "curl -H 'Bad Name: x' https://e.com", "header name isn't valid");
refuses('a header value with a line break', "curl -H $'X-A: a\\nb' https://e.com", 'line break');
refuses('too long', `curl https://e.com -d '${'a'.repeat(100_001)}'`, 'longer than');
refuses('an invalid URL', "curl 'https://'", "URL isn't valid");

// Error messages never quote the pasted command's values (they can be keys).
ran('errors never echo a header value', () => {
  try {
    parseCurl("curl -H $'Authorization: Bearer sk-live-SECRET123\\n' https://e.com");
    assert.fail('should refuse');
  } catch (e) {
    assert.ok(!(e as Error).message.includes('SECRET123'), (e as Error).message);
  }
});

finish('curl-parse-options');
