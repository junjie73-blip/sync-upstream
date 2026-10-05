import type { AuthConfig } from '../domain'
import fs from 'fs-extra'
import { AuthType } from '../domain'
import { AuthenticationError } from '../errors'
import { logger } from '../logger'

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * Environment for the git subprocesses. HTTPS credentials travel inside the remote URL
 * (see `toClonableUrl`); SSH needs `GIT_SSH_COMMAND` instead.
 * A passphrase-protected key is not usable non-interactively, so it is reported rather than
 * silently ignored — git would otherwise hang waiting for input.
 */
export function sshCommand(auth?: AuthConfig): Record<string, string> | undefined {
  if (!auth || auth.type !== AuthType.SSH || !auth.privateKeyPath)
    return undefined
  if (!fs.pathExistsSync(auth.privateKeyPath)) {
    throw new AuthenticationError(`SSH 私钥不存在: ${auth.privateKeyPath}`)
  }
  if (auth.passphrase) {
    logger.warn('SSH 私钥带口令：本工具不会交互式输入口令，请先交给 ssh-agent 管理')
  }
  return {
    GIT_SSH_COMMAND: `ssh -i ${quote(auth.privateKeyPath)} -o IdentitiesOnly=yes -o BatchMode=yes`,
  }
}
