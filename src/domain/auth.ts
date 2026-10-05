export enum AuthType {
  SSH = 'ssh',
  USER_PASS = 'user_pass',
  PAT = 'pat',
}

export interface AuthConfig {
  type: AuthType
  username?: string
  password?: string
  token?: string
  privateKeyPath?: string
  passphrase?: string
}
