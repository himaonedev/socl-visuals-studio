// Local development adapter. No license-server requests or persisted activation.
const identity = Object.freeze({
  email: 'development@localhost',
  licenseKey: 'LOCAL-DEVELOPMENT',
  machineId: 'local-development',
  development: true,
});
module.exports = {
  async checkOnStartup() { return { status: 'valid', cache: { ...identity }, development: true }; },
  async revalidateNow() { return { status: 'valid', development: true }; },
  getCurrentLicense() { return { ...identity }; },
  async activate() { return { ok: false, error: 'local_development_mode' }; },
  deactivate() {},
};
