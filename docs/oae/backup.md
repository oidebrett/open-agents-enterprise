# OAE backups

An OAE installation keeps its state in five places. `deploy/oae/backup/oae-backup stage` (a timer,
every 6 hours) writes one encrypted snapshot of all of them into the setup stack's `config/oae/`,
which manidae-cloud's backup-job pushes to the deployment's private GitHub repository once a day
(support Level 2: 7 copies, Level 3: 28; Level 1 has no backups).

| File | Contents | How it is taken |
|---|---|---|
| `db.sql.gz.age` | The platform database (Agents, versions, Configurations, people, permissions, audit) | `pg_dump`, online |
| `db-roles.sql.age` | Database roles, without passwords | `pg_dumpall --globals-only` |
| `k8s-objects.json.age` | The Agents' namespaces and volume claims (labels, sizes), so a restore can recreate them before the Agents start | `kubectl get ns,pvc` |
| `k8s-secrets.json.age` | Secret values: Agents' credentials (tenant namespaces), the platform's, the edge's (apps, people, Claude laptops) | `kubectl get secret` |
| `volume-<namespace>-<claim>.tar.gz.age` | Each Agent's memory and files | SQLite files through SQLite's online backup (consistent while the Agent runs), other files as they are |
| `prod.tar.gz.age` | `/opt/oce/prod`: installation ID, keys, sign-in secrets, Claude Gateway CA and VPN keys, Helm values | `tar` |
| `manifest.json` | What is inside (plain, no secrets) | |

Claude Gateway session stores are left out: people sign in again after a restore.

**Encryption.** Each file is encrypted with [age](https://age-encryption.org) 1.2.1 to the
public key in `/opt/oce/prod/backup.recipient`. The private key is not on the server: manidae-cloud
keeps it and you can download it. A file whose content did not change keeps last run's ciphertext,
so the repository stores it once.

**Decrypting** (any machine with age, e.g. `brew install age`):

```bash
oae-backup decrypt <snapshot dir> <private key file> <out dir>
# or one file:
age -d -i key.txt -o db.sql.gz db.sql.gz.age
```

**Restoring** an installation onto a fresh server: see manidae-cloud's restore runbook
(`docs/runbooks/restore-from-backup.md`). The restore must reuse the installation ID and keys in
`prod.tar.gz`: Agent and Claude Gateway names, laptops and phone pairings derive from them.

Tested 2026-11-12 on Oracle: a snapshot of the live installation (888 KB), identical files when
nothing changed, a consistent SQLite copy while it was being written, and decryption on macOS.
