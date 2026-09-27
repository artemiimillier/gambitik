/**
 * The owner's account commands on the server (there is no e-mail: a family that lost both the password and the
 * recovery code asks the owner). In the container:
 *
 *   docker exec gambitik node apps/server/src/accounts/admin.ts list
 *   docker exec gambitik node apps/server/src/accounts/admin.ts reset-password <login>
 *   docker exec gambitik node apps/server/src/accounts/admin.ts delete <login>
 *   docker exec gambitik node apps/server/src/accounts/admin.ts invite-new <метка> [сколько раз]
 *   docker exec gambitik node apps/server/src/accounts/admin.ts invite-list | invite-off <метка> | invite-on <метка>
 *
 * `reset-password` prints a new temporary password and a new recovery code ONCE (only their hashes are stored),
 * closes every session of the account and forgets its known devices. `delete` removes the account, its sessions, its
 * known devices and its folder `DATA_DIR/users/<id>/` — then restart the container (`docker restart gambitik`) so no
 * cached state of it stays.
 * `invite-new` makes a family's own invite code (printed ONCE, only its hash is kept), optionally for so many sign-ups;
 * the dashboard shows which code every account came with; `invite-off` closes a code at once (the accounts stay).
 * On the Mac: deploy/docker-ssh/invite.sh does the same over ssh.
 * DATA_DIR comes from the environment (the image sets /data).
 */
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashSecret, newInviteCode, newRecoveryCode, newTemporaryPassword } from './password.ts';
import { inviteHash } from './routes.ts';
import { ACCOUNT_ID_RE, AccountStore, SHARED_INVITE_LABEL, parseLogin } from './store.ts';

function usage(): never {
  console.error('usage: node apps/server/src/accounts/admin.ts list | reset-password <login> | delete <login> | invite-new <label> [uses] | invite-list | invite-off <label> | invite-on <label>');
  process.exit(2);
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  const file = join(dataDir, 'accounts.db');
  if (!existsSync(file)) {
    console.error(`no accounts database in ${dataDir} (GAMBIT_ACCOUNTS is off, or nobody signed up yet)`);
    process.exit(1);
  }
  const [command, raw, extra] = process.argv.slice(2);
  const store = new AccountStore(file);
  try {
    if (command === 'list') {
      const rows = store.list();
      console.log(`${rows.length} account(s)`);
      for (const a of rows) console.log(`${a.display}\tсоздан ${a.created_at.slice(0, 10)}\tпоследний вход ${a.last_login_at?.slice(0, 10) ?? '—'}\tкод ${a.invite_label ?? '—'}`);
      return;
    }
    if (command === 'invite-new') {
      const label = (raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
      if (label === '' || label.length > 40 || label === SHARED_INVITE_LABEL) {
        console.error(`метка: 1–40 символов, не «${SHARED_INVITE_LABEL}»`);
        process.exit(2);
      }
      const uses = extra === undefined ? null : Number(extra);
      if (uses !== null && (!Number.isInteger(uses) || uses < 1 || uses > 10_000)) {
        console.error('сколько раз: целое число 1–10000');
        process.exit(2);
      }
      const code = newInviteCode();
      if (!store.addInvite(label, inviteHash(code), uses)) {
        console.error(`код с меткой «${label}» уже есть`);
        process.exit(1);
      }
      console.log(`код «${label}»${uses === null ? '' : ` (на ${uses} регистр.)`}: ${code}`);
      console.log('Показан один раз и нигде не сохранён — перешлите его семье.');
      return;
    }
    if (command === 'invite-list') {
      const invites = store.listInvites();
      const byLabel = new Map<string, number>();
      for (const a of store.list()) byLabel.set(a.invite_label ?? '—', (byLabel.get(a.invite_label ?? '—') ?? 0) + 1);
      console.log(`${SHARED_INVITE_LABEL} (GAMBIT_INVITE_CODE, set-invite.sh)\tаккаунтов ${byLabel.get(SHARED_INVITE_LABEL) ?? 0}`);
      for (const i of invites) {
        console.log(`${i.label}\t${i.disabled === 1 ? 'выключен' : 'включён'}\tиспользован ${i.uses}${i.max_uses === null ? '' : ` из ${i.max_uses}`}\tсоздан ${i.created_at.slice(0, 10)}`);
      }
      if ((byLabel.get('—') ?? 0) > 0) console.log(`без метки\tаккаунтов ${byLabel.get('—')}`);
      return;
    }
    if (command === 'invite-off' || command === 'invite-on') {
      if (!store.setInviteDisabled(raw ?? '', command === 'invite-off')) {
        console.error(`нет кода с меткой «${raw ?? ''}» (общий код закрывается set-invite.sh --off)`);
        process.exit(1);
      }
      console.log(`код «${raw}» ${command === 'invite-off' ? 'выключен: по нему больше не зарегистрироваться' : 'снова включён'}`);
      return;
    }
    if (command !== 'reset-password' && command !== 'delete') usage();
    const login = parseLogin(raw);
    const account = login === null ? undefined : store.byLogin(login.key);
    if (account === undefined) {
      console.error(`нет аккаунта «${raw ?? ''}»`);
      process.exit(1);
    }
    if (command === 'reset-password') {
      const password = newTemporaryPassword();
      const recoveryCode = newRecoveryCode();
      const [passHash, recoveryHash] = await Promise.all([hashSecret(password), hashSecret(recoveryCode)]);
      store.db.tx(() => {
        store.setPassword(account.id, passHash);
        store.setRecovery(account.id, recoveryHash);
        store.closeAllSessions(account.id);
        store.forgetDevices(account.id);
      });
      console.log(`«${account.display}»: новый пароль ${password}`);
      console.log(`новый код восстановления ${recoveryCode}`);
      console.log('Передайте их семье; все входы этого аккаунта закрыты. Они показаны один раз и нигде не сохранены.');
      return;
    }
    if (!ACCOUNT_ID_RE.test(account.id)) throw new Error('unexpected account id');
    store.delete(account.id);
    const dir = join(dataDir, 'users', account.id);
    rmSync(dir, { recursive: true, force: true });
    console.log(`«${account.display}» удалён вместе с данными. Перезапустите контейнер: docker restart gambitik`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
