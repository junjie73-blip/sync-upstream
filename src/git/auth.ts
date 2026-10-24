import type { AuthConfig } from '../domain'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { AuthType } from '../domain'
import { AuthenticationError } from '../errors'
import { t } from '../i18n'
import { logger } from '../logger'

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * Environment for the git subprocesses. HTTPS credentials travel inside the remote URL
 * (see `toClonableUrl`); SSH needs `GIT_SSH_COMMAND` instead.
 * A passphrase-protected key is not usable non-interactively, so it is reported rather than
 * silently ignored — git would otherwise hang waiting for input.
 *
 * A relative `privateKeyPath` is resolved against `baseDir` — the directory the run operates
 * on — and handed to ssh as an absolute path, so `doctor` and the real run agree on which
 * file they are talking about.
 */
export function sshCommand(auth?: AuthConfig, baseDir = process.cwd()): Record<string, string> | undefined {
  if (!auth || auth.type !== AuthType.SSH || !auth.privateKeyPath)
    return undefined
  const key = path.resolve(baseDir, auth.privateKeyPath)
  if (!fs.pathExistsSync(key)) {
    throw new AuthenticationError(t('e.sshKeyMissing', { key }))
  }
  if (auth.passphrase) {
    logger.warn('SSH 私钥带口令：本工具不会交互式输入口令，请先交给 ssh-agent 管理')
  }
  return {
    GIT_SSH_COMMAND: `ssh -i ${quote(key)} -o IdentitiesOnly=yes -o BatchMode=yes`,
  }
}
