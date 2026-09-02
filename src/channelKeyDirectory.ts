import type { ChannelKeyDirectory } from '@omadia/channel-sdk';

/**
 * Channel-key directory contribution for the operator channels dashboard
 * (`GET /api/v1/operator/channels`). The kernel's ChannelDirectoryRegistry
 * aggregates one directory per channel type; this one lists the single
 * routable key an iMessage channel owns — the configured Sendblue line.
 *
 * Binding semantics: a binding on the line's E.164 acts as the channel-wide
 * default Agent (every conversation reaches the line), while a binding on a
 * specific sender E.164 wins over it (see `resolveAgentForTurn` in plugin.ts,
 * which tries the sender key first, then the line key).
 */

/** Narrow shim of the kernel's `channelDirectoryRegistry` service — only the
 *  two methods this plugin consumes, so no dependency on middleware types. */
export interface ChannelDirectoryRegistryShim {
  register(directory: ChannelKeyDirectory): void;
  unregister(channelType: string): void;
}

export interface IMessageDirectoryOptions {
  /** The configured Sendblue line (E.164) — the one key this plugin routes. */
  fromNumber: string;
  /** Plugin id shown as the dashboard's "via …" hint (`ctx.agentId`). */
  originPluginId: string;
}

export function buildIMessageKeyDirectory(opts: IMessageDirectoryOptions): ChannelKeyDirectory {
  return {
    channelType: 'imessage',
    originPluginId: opts.originPluginId,
    listKeys: () =>
      Promise.resolve([
        {
          key: opts.fromNumber,
          label: `iMessage line ${opts.fromNumber}`,
          hint: 'Sendblue relay · binds every conversation on this line',
        },
      ]),
  };
}
