import type { Impl } from '../registry.ts';
import { pluginsHostImpls } from './plugins-host.ts';
import { pluginsInstallImpls } from './plugins-install.ts';
import { pluginsLinkImpls } from './plugins-links.ts';

export const pluginsImpls: Impl[] = [...pluginsInstallImpls, ...pluginsHostImpls, ...pluginsLinkImpls];
