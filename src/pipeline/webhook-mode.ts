import type { SyncConfig, WebhookDelivery } from '../domain'
import path from 'node:path'
import process from 'node:process'
import { toError } from '../errors'
import { configureLogging, logger } from '../logger'
import { eventFromFailure, eventFromRun } from '../notify'
import { withRetry } from '../retry'
import { announceSyncEvent, runSync } from '../sync'
import { WebhookServer } from '../webhook'
import { DeliveryLog } from '../webhook/delivery-log'

/**
 * Daemon mode: keep listening and run one sync per accepted delivery.
 * A failing sync is logged and does not take the server down.
 *
 * Deliveries are serialised by the repository lock inside `runSync`, so a burst of
 * webhooks queues instead of racing on one working tree. Transient failures retry through
 * `webhookConfig.retryConfig`, which used to be a declared-but-unread key.
 */
export async function serveWebhooks(config: SyncConfig, cwd = process.cwd()): Promise<number> {
  const webhookConfig = config.webhookConfig
  if (!webhookConfig?.enable) {
    logger.warn('webhookConfig.enable 为 false，未启动监听')
    return 0
  }

  // A daemon's console is the one place a log line can get lost: journald rotates, a container's
  // stdout goes wherever the runtime feels like, and "who restarted me at 03:12" is unanswered
  // either way. The file is the durable copy, and the webhook secret never belongs in it.
  const secrets = [webhookConfig.secret, config.authConfig?.token, config.authConfig?.password]
  const logFile = configureLogging(config.logConfig, { secrets, cwd })
  if (logFile)
    logger.info(`日志同时写入 ${logFile}`)

  const deliveryLogFile = webhookConfig.deliveryLog ? path.resolve(cwd, webhookConfig.deliveryLog) : undefined
  const deliveryLog = deliveryLogFile ? new DeliveryLog(deliveryLogFile, secrets.filter((item): item is string => typeof item === 'string' && item.length > 0)) : undefined

  let shuttingDown = false

  const server = new WebhookServer(
    { ...webhookConfig, ...(deliveryLogFile ? { deliveryLog: deliveryLogFile } : {}) },
    {
      onDelivery: deliveryLog ? record => deliveryLog.record(record) : undefined,
      onSync: async (delivery: WebhookDelivery) => {
        if (shuttingDown) {
          logger.warn('正在退出，忽略新的同步投递')
          return
        }
        logger.info(`收到 ${delivery.platform} ${delivery.event} (${delivery.branch})，开始同步`)
        const startedAt = Date.now()
        try {
          // `notify: false` because this loop retries: announcing every attempt would post the
          // same transient network failure to the team channel once per retry.
          const result = await withRetry(
            () => runSync({ config: { ...config, nonInteractive: true, autoPush: config.autoPush }, notify: false }),
            {
              ...(webhookConfig.retryConfig ?? config.retryConfig),
              isRetryable: error => /网络|network|connect|resolve host|timed out|timeout|RPC failed|early EOF|The remote end/i.test(error.message),
            },
          )
          await announceSyncEvent(config, eventFromRun(config, result, startedAt), result.previewed)
        }
        catch (error) {
          await announceSyncEvent(config, eventFromFailure(config, error, startedAt), false)
          // 抛出交给 `WebhookServer.runSync`：那里统一记日志、写审计，并在退出时等着它结束。
          throw error
        }
      },
    },
  )

  // One crash handler for the whole daemon: an unhandled rejection in a one-shot CLI run is a
  // failed exit code, but in a process meant to be listening it is a service that quietly stopped
  // answering webhooks. Log it loudly and stay up; a real fault still shows up as failed deliveries.
  installDaemonErrorHandlers()

  const { port, host, secure } = await server.start()
  // Print what it actually bound to: a line saying `0.0.0.0` when the socket is on loopback is how
  // an operator ends up filing a firewall ticket for a port that was never open.
  logger.success(`Webhook 服务已启动: ${secure ? 'https' : 'http'}://${host}:${port}${webhookConfig.path}（Ctrl+C 退出）`)
  if (deliveryLog)
    logger.info(`投递决定写入 ${deliveryLog.path}`)
  else
    logger.warn('未设置 webhookConfig.deliveryLog：投递决定只出现在控制台，进程退出后无从回看')

  const pending = server.pendingSyncs()
  await waitForShutdown()
  shuttingDown = true
  // Stop accepting first, then let in-flight syncs finish so a SIGTERM during a commit
  // cannot leave the working tree half-applied.
  await server.stop()
  await pending
  logger.info('Webhook 服务已停止')
  return 0
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve()
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

/** Registered once per process, so a test suite that starts the daemon twice gets one listener. */
let handlersInstalled = false

function installDaemonErrorHandlers(): void {
  if (handlersInstalled)
    return
  handlersInstalled = true
  const onLooseError = (label: string) => (error: unknown) => {
    logger.error(`Webhook 守护进程遇到未处理的${label}: ${toError(error).message}`, toError(error))
  }
  process.on('unhandledRejection', onLooseError(' Promise 拒绝'))
  process.on('uncaughtException', onLooseError('异常'))
}
