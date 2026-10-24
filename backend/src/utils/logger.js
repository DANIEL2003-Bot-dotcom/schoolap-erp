/** Logger JSON minimal (une ligne par événement, lisible dans les logs Render). */
function write(level, msg, fields = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
