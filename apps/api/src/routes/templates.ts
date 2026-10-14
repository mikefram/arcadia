import {
  archiveTemplate,
  createTemplate,
  diffTemplateVersions,
  getTemplate,
  loadPresets,
  getTemplateVersion,
  listTemplates,
  publishTemplate,
  saveTemplateDraft,
  simulateTemplate,
  validateTemplateDraft,
} from '@mihato/backend';
import type { Registrar } from '../registrar';

/** SPEC 10.4: mẫu quy trình. Người có `template.edit` thấy cả nháp; người khác chỉ thấy bản đã xuất bản (kiểm ở service). */
export function registerTemplateRoutes(r: Registrar): void {
  r.user('templates.list', async ({ tx, ctx, viewer, input }) => ({ items: await listTemplates(tx, ctx, viewer, input.query) }));
  r.user('templates.presets', async () => ({ items: loadPresets() }));
  r.user('templates.get', ({ tx, ctx, viewer, input }) => getTemplate(tx, ctx, viewer, input.params.id));
  r.user('templates.version', ({ tx, ctx, viewer, input }) => getTemplateVersion(tx, ctx, viewer, input.params.id, input.params.n));
  r.user('templates.create', ({ tx, ctx, viewer, input }) => createTemplate(tx, ctx, viewer, input.body));
  r.user('templates.saveDraft', ({ tx, viewer, input, ifMatch }) => saveTemplateDraft(tx, viewer, input.params.id, input.body, ifMatch));
  r.user('templates.validate', ({ tx, ctx, input }) => validateTemplateDraft(tx, ctx, input.params.id));
  r.user('templates.simulate', ({ tx, ctx, viewer, input }) => simulateTemplate(tx, ctx, viewer, input.params.id, input.body));
  r.user('templates.publish', ({ tx, ctx, viewer, input, meta }) => publishTemplate(tx, ctx, viewer, input.params.id, meta));
  r.user('templates.archive', ({ tx, ctx, viewer, input, meta }) => archiveTemplate(tx, ctx, viewer, input.params.id, input.body.archived, meta));
  r.user('templates.diff', ({ tx, input }) => diffTemplateVersions(tx, input.params.id, input.query.from, input.query.to));
}
