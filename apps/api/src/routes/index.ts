import type { Registrar } from '../registrar';
import { registerAdminRoutes } from './admin';
import { registerAuthRoutes } from './auth';
import { registerFileRoutes } from './files';
import { registerInternalRoutes } from './internal';
import { registerNotificationRoutes } from './notifications';
import { registerOrgRoutes } from './org';
import { registerProposalRoutes } from './proposals';
import { registerRunRoutes } from './runs';
import { registerTemplateRoutes } from './templates';

/** Mỗi nhóm route một tệp; handler mỏng, nghiệp vụ nằm ở @mihato/backend. */
export function registerAllRoutes(r: Registrar): void {
  registerAuthRoutes(r);
  registerOrgRoutes(r);
  registerTemplateRoutes(r);
  registerRunRoutes(r);
  registerFileRoutes(r);
  registerNotificationRoutes(r);
  registerProposalRoutes(r);
  registerInternalRoutes(r);
  registerAdminRoutes(r);
}
