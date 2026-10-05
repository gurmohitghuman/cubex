# Run Cubex on your own server

This guide takes you from a new Linux server to Cubex on your own domain, with:

- HTTPS, using a free certificate that renews itself
- a password that's set before anyone else can reach the page
- Cubex starting again by itself after a reboot
- a backup every night

It takes about 20 minutes, and every step is a command you paste into a terminal. If you only want Cubex on your own computer, you don't need any of this: the one-line install in the [README](../README.md#install) is enough.

The commands are for Ubuntu (24.04 or newer) and Debian (12 or newer). Other Linux distributions work too, but they install packages differently.

## What you need

- **A server with a public IP address.** Any VPS provider works (Hetzner, DigitalOcean, Vultr, Linode and others). 2 GB of memory is comfortable. 1 GB works if you add swap in step 2, because the install needs about 1.5 GB while it builds. 20 GB of disk is plenty to start.
- **A domain name** from any registrar. You'll point one subdomain at the server, for example `cubex.example.com`.
- **The SSH login your provider gave you**, for example `ssh root@203.0.113.10`. Windows, macOS and Linux all have `ssh` in their terminal.

In every command below, replace `cubex.example.com` with your subdomain and `203.0.113.10` with your server's IP address.

## 1. Point your domain at the server

Open your domain's DNS settings (at your registrar, or at Cloudflare if you use it) and add one record:

| Type | Name | Value |
|---|---|---|
| `A` | `cubex` | your server's IPv4 address, for example `203.0.113.10` |

Add an `AAAA` record only if your server has a working IPv6 address. A wrong one can stop the HTTPS certificate in step 4 from being issued.

On Cloudflare, set the record to **DNS only** (grey cloud). With Cloudflare's proxy on (orange cloud), Caddy may not be able to get its certificate, and Cloudflare's free plan rejects uploads over 100 MB, which blocks large CSV imports.

DNS changes usually take a few minutes. To check, run this on your own computer. It should print your server's IP address:

```bash
nslookup cubex.example.com
```

You can carry on with steps 2 and 3 while you wait.

## 2. Prepare the server

Sign in with the login your provider gave you:

```bash
ssh root@203.0.113.10
```

**Create a user for Cubex.** If you're signed in as `root`, create a normal user to run Cubex. Running apps as root means a bug in any one of them can take over the whole server. (If your provider gave you a normal user with `sudo` already, such as `ubuntu`, use that one and skip to "Then, as that user".)

```bash
apt update && apt install -y sudo
adduser cubex && usermod -aG sudo cubex
```

`adduser` asks for a password, which you'll type whenever you use `sudo`. Press Enter to skip its other questions. Next, let the new user sign in with the SSH key you used for root (skip this if you sign in with a password):

```bash
mkdir -p -m 700 /home/cubex/.ssh
cp ~/.ssh/authorized_keys /home/cubex/.ssh/
chown -R cubex:cubex /home/cubex/.ssh
```

Sign out with `exit`, then sign back in **directly as the new user**. Use this login from now on:

```bash
ssh cubex@203.0.113.10
```

Don't switch to the user with `su` or `sudo -u` instead. A session started that way can't set Cubex up to start with the server.

**Then, as that user**, update the system. If the upgrade asks about restarting services or keeping a configuration file, press Enter to accept the default.

```bash
sudo apt update && sudo apt upgrade -y
```

Install the tools this guide uses:

```bash
sudo apt install -y curl openssl ufw sqlite3 cron
sudo loginctl enable-linger $USER
```

The last line lets your user's programs keep running after you sign out and start when the server boots, so Cubex comes back after a reboot. `sqlite3` and `cron` are for the nightly backups in step 6.

**Turn on the firewall.** Allow SSH first so you don't lock yourself out, then the two web ports, then switch it on. Answer `y` when it asks. (If your SSH login uses a port other than 22, allow that one too before `ufw enable`, for example `sudo ufw allow 2222/tcp`.)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If your provider has its own firewall in its dashboard (Hetzner Cloud Firewall, AWS security groups, Oracle Cloud security lists and similar), allow ports 22, 80 and 443 there too. Cubex's own port, 3002, stays closed: Cubex only answers on the server itself, and Caddy (step 4) is the way in.

**Only if the server has less than 2 GB of memory**, add 2 GB of swap so the install doesn't run out of memory:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Install Cubex with its password already set

A fresh Cubex lets whoever opens it first choose the password. Once your site has an HTTPS certificate, its address appears in public certificate logs, and bots visit new sites within minutes. So install Cubex without starting it, set the password, then start it:

```bash
curl -fsSL https://raw.githubusercontent.com/gurmohitghuman/cubex/main/install.sh | bash -s -- --no-start
echo "INITIAL_PASSWORD=$(openssl rand -base64 18)" >> ~/.cubex/config.env
source ~/.bashrc
cubex start
```

The second line generates a strong password and saves it in Cubex's settings file. Cubex creates your account with it on the first start. `source ~/.bashrc` lets this window find the new `cubex` command. Show the password, and save it in your password manager:

```bash
grep INITIAL_PASSWORD ~/.cubex/config.env
```

`cubex start` says `Cubex is running: http://localhost:3002`. That address only works on the server itself, which is what you want: the next step puts Cubex on your domain. Check that it will start with the server:

```bash
cubex status
```

It should say `Runs as: a systemd user service`. If it says `a background process`, see [Troubleshooting](#troubleshooting).

## 4. Turn on HTTPS with Caddy

Caddy is a web server that gets a free HTTPS certificate from Let's Encrypt and renews it on its own. Install it from its official package repository. These are the commands from [caddyserver.com/docs/install](https://caddyserver.com/docs/install):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Now point Caddy at Cubex. Replace `cubex.example.com` with your domain, then paste all six lines:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
cubex.example.com {
    reverse_proxy 127.0.0.1:3002
}
EOF
sudo systemctl restart caddy
```

Caddy gets the certificate within a minute or so. It also sends `http://` visitors to `https://`, and tells Cubex the connection is secure, so your sign-in cookie only ever travels over HTTPS.

## 5. Sign in

Open `https://cubex.example.com` and sign in with the password from step 3. You can change it later in **Settings**.

Cubex only needed the password in the settings file to create your account, so remove it from there:

```bash
sed -i '/^INITIAL_PASSWORD=/d' ~/.cubex/config.env
```

From here, everything works as the [README](../README.md#run) describes: add your OpenRouter key and default model in **Settings → AI**. Webhook URLs and the agent (MCP) setup shown in the app already use your domain.

## 6. Back up every night

Everything Cubex keeps is in `~/.cubex/data`. The backup script takes a consistent snapshot of the database while Cubex runs, and copies the two key files next to it. Try it once. The output should include `integrity_check: ok`:

```bash
mkdir -p -m 700 ~/backups
~/.cubex/app/scripts/backup-cubex-db.sh ~/.cubex/data/cubex.db ~/backups/cubex-first.db
```

Then schedule it for 03:00 every night, keeping the last 14 days:

```bash
(crontab -l 2>/dev/null; echo '0 3 * * * $HOME/.cubex/app/scripts/backup-cubex-db.sh $HOME/.cubex/data/cubex.db $HOME/backups/cubex-$(date +\%F).db >> $HOME/backups/backup.log 2>&1 && find $HOME/backups -name "cubex-*" -mtime +14 -delete') | crontab -
```

`crontab -l` shows the schedule, and `tail ~/backups/backup.log` shows how the last runs went. Old backups are only deleted after a new one succeeds. A backup on the same server is lost along with the server, so also:

- Turn on your provider's automatic backups or snapshots (most offer them for a small fee), or copy `~/backups` to another machine now and then.
- Keep a copy of `~/.cubex/data/.encryption-key` somewhere safe off the server, such as your password manager. `cat ~/.cubex/data/.encryption-key` prints it. Without it, the API keys saved in a backup can't be decrypted.

To restore, stop Cubex, delete the `-wal` and `-shm` files (they belong to the database you're replacing), copy the backup in, and start Cubex again. `ls ~/backups` lists your backups. For the one from 31 January 2026, for example:

```bash
cubex stop
rm -f ~/.cubex/data/cubex.db-wal ~/.cubex/data/cubex.db-shm
cp ~/backups/cubex-2026-01-31.db ~/.cubex/data/cubex.db
cp ~/backups/cubex-2026-01-31.encryption-key ~/.cubex/data/.encryption-key
cp ~/backups/cubex-2026-01-31.jwt-secret ~/.cubex/data/.jwt-secret
cubex start
```

## 7. Keep it up to date

- **Cubex:** run `cubex update`. Your data and settings stay, and if the new version doesn't start, the previous one comes back.
- **The server and Caddy:** run `sudo apt update && sudo apt upgrade -y` now and then. Ubuntu also installs security updates by itself.

## Troubleshooting

| Problem | What to do |
|---|---|
| The `https://` address doesn't load, or the browser warns about the certificate | Look at Caddy's log: `sudo journalctl -u caddy --no-pager -n 50`. The usual causes: the domain doesn't point at the server yet (`nslookup cubex.example.com`), ports 80 and 443 are closed in your provider's firewall, an `AAAA` record points somewhere else, or Cloudflare's proxy is on. Caddy keeps retrying by itself; `sudo systemctl restart caddy` retries at once. |
| `502 Bad Gateway` | Caddy works, but Cubex isn't running. Run `cubex status`, then `cubex logs` to see why. |
| Cubex is down after a reboot, or `cubex status` says `a background process` | Usually the install ran in a session started with `su` or `sudo -u`. Sign in directly (`ssh cubex@203.0.113.10`) and run `cubex stop`, then `sed -i 's/^CUBEX_SERVICE=.*/CUBEX_SERVICE=systemd/' ~/.cubex/config.env`, then `sudo loginctl enable-linger $USER`, then `cubex start`. |
| `cubex: command not found` | Open a new SSH session, or run `source ~/.bashrc`. |
| The install fails while building | Usually it ran out of memory: add swap (step 2) and run the install command again. If the log mentions `node-gyp` or a compiler, run `sudo apt install -y build-essential python3` first. |
| Large CSV imports fail | Something between your browser and Cubex limits upload size: nginx (see below) or Cloudflare's proxy (100 MB on the free plan). Caddy has no limit. |
| You forgot the password | Run `cubex reset-password` on the server. It signs out every browser. |

## Other setups

### nginx instead of Caddy

If the server already runs nginx, use this site configuration (for example in `/etc/nginx/sites-available/cubex`, linked into `sites-enabled`). Then get the certificate with Certbot: `sudo apt install -y certbot python3-certbot-nginx`, then `sudo certbot --nginx -d cubex.example.com`.

```nginx
server {
    listen 80;
    server_name cubex.example.com;

    client_max_body_size 500m;      # CSV imports: nginx allows only 1 MB by default

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;        # live progress while runs fill cells
        proxy_read_timeout 1h;      # keeps those progress streams open
    }
}
```

### Docker instead of the installer

Two changes make a Docker install as safe as the steps above. Make both in the folder you cloned (see [Docker](../README.md#docker) in the README). First, in `docker-compose.override.yaml`, change the port line to `"127.0.0.1:3002:3002"`. Ports that Docker publishes skip the `ufw` firewall, so the default `"3002:3002"` would put Cubex on the internet over plain HTTP. Second, set the password before the first start. The compose file reads it from `SERVICE_PASSWORD_CUBEX`:

```bash
echo "SERVICE_PASSWORD_CUBEX=$(openssl rand -base64 18)" >> .env
docker compose up -d
```

`cat .env` shows the password. Then add Caddy as in step 4. Your data lives in the `cubex-data` volume. To back it up, copy the backup script into the container (again after each rebuild) and run it there. The snapshot lands in the volume, next to `cubex.db`:

```bash
docker compose cp scripts cubex:/app/scripts
docker compose exec cubex bash /app/scripts/backup-cubex-db.sh /app/server/data/cubex.db /app/server/data/backup-$(date +%F).db
```

### No public IP (a home server or a laptop)

Use a tunnel such as [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), which needs no open ports. If you open Cubex on a different address than the tunnel's (for example `http://localhost:3002`), set `PUBLIC_URL` in `~/.cubex/config.env` to the tunnel's address and run `cubex restart`, so the app shows the right webhook URL. Cloudflare limits uploads to 100 MB on its free plan.

### Only you need access

If no outside service needs to reach Cubex (no webhooks), you can skip the domain and HTTPS. Do steps 2 and 3, then reach Cubex through an SSH tunnel from your own computer:

```bash
ssh -N -L 3002:127.0.0.1:3002 cubex@203.0.113.10
```

While that runs, open `http://localhost:3002`. A private network such as Tailscale works too.
