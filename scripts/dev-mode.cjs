// Refresh frontend changes and restart native code by default.
// Use --no-watch when a download/render should survive source edits.
function configureDevMode(input, environment) {
  const args = [...input], env = { ...environment };
  if (args[0] !== 'dev') return { args, env, watch: null };
  const separator = args.indexOf('--');
  const optionEnd = separator < 0 ? args.length : separator;
  const options = args.slice(1, optionEnd);
  const watch = !options.includes('--no-watch');
  const forwarded = args.slice(0, optionEnd).filter(value => value !== '--watch').concat(args.slice(optionEnd));
  if (!watch && !options.includes('--no-watch')) forwarded.splice(1, 0, '--no-watch');
  env.SOCL_DEV_WATCH = watch ? '1' : '0';
  return { args: forwarded, env, watch };
}

function isLegacyUiSource(name, scripts) {
  return typeof name === 'string' && (name === 'index.html' || name.endsWith('.css') || scripts.includes(name));
}
module.exports = { configureDevMode, isLegacyUiSource };
