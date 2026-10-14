// curl's options, so the parser knows which ones take a value: without that,
// "-x proxy:8080 https://api..." would read proxy:8080 as the URL. Taken from
// curl's manual (8.x). An option missing here is refused by name, never guessed.

// Short letters and the long option each one stands for.
export const SHORT_OPTIONS: Record<string, string> = {
  A: 'user-agent', b: 'cookie', c: 'cookie-jar', C: 'continue-at', d: 'data', D: 'dump-header', e: 'referer',
  E: 'cert', F: 'form', H: 'header', K: 'config', m: 'max-time', o: 'output', P: 'ftp-port', Q: 'quote',
  r: 'range', t: 'telnet-option', T: 'upload-file', u: 'user', U: 'proxy-user', w: 'write-out', x: 'proxy',
  X: 'request', y: 'speed-time', Y: 'speed-limit', z: 'time-cond',
  '0': 'http1.0', '1': 'tlsv1', '2': 'sslv2', '3': 'sslv3', '4': 'ipv4', '6': 'ipv6', '#': 'progress-bar',
  ':': 'next', a: 'append', B: 'use-ascii', f: 'fail', g: 'globoff', G: 'get', h: 'help', i: 'include',
  I: 'head', j: 'junk-session-cookies', J: 'remote-header-name', k: 'insecure', l: 'list-only', L: 'location',
  M: 'manual', n: 'netrc', N: 'no-buffer', O: 'remote-name', p: 'proxytunnel', q: 'disable', R: 'remote-time',
  s: 'silent', S: 'show-error', v: 'verbose', V: 'version', Z: 'parallel',
};

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const TAKES_VALUE = words(`
  abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout connect-to
  continue-at cookie cookie-jar create-file-mode crlfile curves data data-ascii data-binary data-raw
  data-urlencode delegation dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url dump-header ech
  egd-file engine etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user
  ftp-method ftp-port ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip header hostpubmd5
  hostpubsha256 hsts interface ip-tos ipfs-gateway json keepalive-cnt keepalive-time key key-type knownhosts krb
  libcurl limit-rate local-port login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time
  netrc-file noproxy oauth2-bearer output output-dir parallel-max parallel-max-host pass pinnedpubkey preproxy
  proto proto-default proto-redir proxy proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers
  proxy-crlfile proxy-header proxy-key proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name
  proxy-tls13-ciphers proxy-tlsauthtype proxy-tlspassword proxy-tlsuser proxy-user proxy1.0 pubkey quote
  random-file range rate referer request request-target resolve retry retry-delay retry-max-time sasl-authzid
  service-name sigalgs socks4 socks4a socks5 socks5-gssapi-service socks5-hostname speed-limit speed-time
  ssl-sessions stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers tlsauthtype tlspassword
  tlsuser trace trace-ascii trace-config unix-socket upload-file upload-flags url url-query user user-agent
  variable vlan-priority write-out
`);

// Flags. curl also accepts --no-<flag> for each, e.g. --no-progress-meter.
const FLAGS = words(`
  alpn anyauth append basic buffer ca-native cert-status clobber compressed compressed-ssh create-dirs crlf
  digest disable disable-eprt disable-epsv disallow-username-in-url fail fail-early fail-with-body false-start
  form-escape ftp-create-dirs ftp-pasv ftp-pret ftp-skip-pasv-ip ftp-ssl ftp-ssl-control get globoff
  haproxy-protocol head help http0.9 http1.0 http1.1 http2 http2-prior-knowledge http3 http3-only
  ignore-content-length include insecure ipv4 ipv6 junk-session-cookies keepalive list-only location
  location-trusted manual metalink mptcp negotiate netrc netrc-optional next npn ntlm ntlm-wb parallel
  parallel-immediate path-as-is post301 post302 post303 progress-bar progress-meter proxy-anyauth proxy-basic
  proxy-ca-native proxy-digest proxy-http2 proxy-insecure proxy-negotiate proxy-ntlm proxy-ssl-allow-beast
  proxy-ssl-auto-client-cert proxytunnel raw remote-header-name remote-name remote-name-all remote-time
  remove-on-error retry-all-errors retry-connrefused sasl-ir sessionid show-error show-headers silent
  skip-existing socks5-basic socks5-gssapi socks5-gssapi-nec ssl ssl-allow-beast ssl-auto-client-cert
  ssl-no-revoke ssl-reqd ssl-revoke-best-effort sslv2 sslv3 styled-output suppress-connect-headers tcp-fastopen
  tcp-nodelay tftp-no-options tlsv1 tlsv1.0 tlsv1.1 tlsv1.2 tlsv1.3 tr-encoding trace-ids trace-time use-ascii
  verbose version xattr
`);

export function optionArity(longName: string): 'value' | 'flag' | null {
  if (TAKES_VALUE.has(longName)) return 'value';
  if (FLAGS.has(longName)) return 'flag';
  if (longName.startsWith('no-') && FLAGS.has(longName.slice(3))) return 'flag';
  return null;
}
