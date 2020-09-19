const cloneDeep = require('lodash/cloneDeep');

const fmt = require('pg-format');
const esc = {
  col:   fmt.ident,
  num:   fmt.literal,
  table: fmt.ident,
};

const NOW = { NOW:'NOW' }; // placeholder for timestamp of statement execution

module.exports = (pool, models, defaultAttributes={}) => {
  models            = cloneDeep(models);
  defaultAttributes = cloneDeep(defaultAttributes);

  Object.entries(models)
    .forEach(([ modelName, model ]) => {
      initialiseModel(modelName, model);
    });

  return { sendNativeQuery, transaction, models };

  function getModelWithName(name) {
    for(const model of Object.values(models)) {
      if(model.globalId.toLowerCase() === name.toLowerCase()) { // or match tableName?
        return model;
      }
    }
    throw new Error(`Model not found: ${name}`);
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await fn(client);

      await client.query('COMMIT');

      return res;
    } catch(err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  function sendNativeQuery(sql, args, opts) {
    opts = { ...opts, intercepters:{} };

    const returnable = { fetch, intercept, limit, populate, sort, then, usingConnection };
    return returnable;

    function usingConnection(client) {
      opts.client = client;
      return returnable;
    }

    function fetch() {
      opts.fetch = true;
      return returnable;
    }

    function intercept(errName, handler) {
      getErrorCodesFor(errName)
        .forEach(code => {
          opts.intercepters[code] = handler;
        });
      return returnable;
    }

    function limit(limit) {
      if(!Number.isSafeInteger(limit)) {
        throw new Error('Limit must be an integer.');
      }
      opts.limit = limit;
      return returnable;
    }

    function populate(prop) {
      opts.populate = prop;
      return returnable;
    }

    function sort(criteria) {
      opts.orderBy = criteria;
      return returnable;
    }

    async function then(resolve, reject) {
      if(opts.fetch) {
        sql += ' RETURNING *';
      }
      sql += buildOrderByQuery(opts.orderBy);
      sql += buildLimitQuery(opts.limit);

      if(args) {
        // Substitute timestamps here so they are all identical for the same statement.
        // N.B. statements in the same transaction may generate different timestamps.
        const now = Date.now();
        args = args.map(it => it === NOW ? now : it);
      }

      let client;
      try {
        client = opts.client || await pool.connect();
        const result = await client.query(sql, args);

        if(opts.returnSingleRow || (opts.fetch && opts.single)) {
          const ret = withSelectedValuesCast(opts.Model, result.rows[0]);

          if(opts.populate) {
            const populateModel = getModelWithName(opts.Model.attributes[opts.populate].model);
            const sql = `SELECT * FROM ${esc.table(populateModel.tableName)} WHERE id=$1`;
            const { rows } = await client.query(sql, [ ret[opts.populate] ]);
            ret[opts.populate] = withSelectedValuesCast(populateModel, rows[0]);
          }

          resolve(ret);
        } else if(opts.returnRows || opts.fetch) {
          const ret = result.rows.map(row => withSelectedValuesCast(opts.Model, row));

          if(opts.populate) {
            const populateModel = getModelWithName(opts.Model.attributes[opts.populate].model);
            const populateIds = ret.map(r => r[opts.populate]);
            const sql = `SELECT * FROM ${esc.table(populateModel.tableName)} WHERE id=ANY($1)`;
            const { rows } = await client.query(sql, [ populateIds ]);
            ret.forEach(r => {
              r[opts.populate] = withSelectedValuesCast(populateModel, rows.find(({ id }) => r[opts.populate] === id));
            });
          }

          resolve(ret);
        } else {
          resolve(result);
        }
      } catch(err) {
        const intercepter = opts.intercepters[err.code];

        if(!intercepter) {
          reject(err);
        } else if(typeof intercepter === 'function') {
          reject(intercepter(err));
        } else if(typeof intercepter === 'string') {
          reject(intercepter);
        } else {
          throw new Error(`No handling for intercepter of this type yet: '${intercepter}'`);
        }
      } finally {
        if(client && !opts.client) {
          client.release();
        }
      }
    }
  }

  function initialiseModel(name, Model) {
    Model.globalId  = name;
    Model.tableName = name.toLowerCase();
    Model.attributes = { ...cloneDeep(defaultAttributes), ...Model.attributes };

    Model.create = props => {
      props = withDefaultValues(Model, props, { creating:true });

      const cols = Object.keys(props);
      const values = [];
      return sendNativeQuery(`
        INSERT INTO ${esc.table(Model.tableName)}
            ${buildColumnNamesQuery(cols)}
            VALUES ${buildValuesQuery(Model, cols, props, values)}
      `, values, { Model, single:true });
    };
    Model.createEach = propses => {
      propses = propses.map(props => withDefaultValues(Model, props, { creating:true }));

      if(!propses.length) {
        return {
          fetch: () => ({
            usingConnection: () => [],
            then: resolve => resolve([]),
          }),
          usingConnection: () => {},
        };
      }

      // TODO assert that all propses have the same columns.  If not, we'd have
      // to do separate inserts for all of them, which seems like effort to
      // support, and potentially unnecessary.

      const cols = Object.keys(propses[0]);
      const values = [];
      return sendNativeQuery(`
        INSERT INTO ${esc.table(Model.tableName)}
            ${buildColumnNamesQuery(cols)}
            VALUES ${propses.map(props => buildValuesQuery(Model, cols, props, values)).join(',\n                   ')}
      `, values, { Model });
    };
    Model.destroy    = () => {};
    Model.destroyOne = () => {};
    Model.find       = (options={}) => {
      const { select, criteria, orderBy, limit } = getFindCriteriaFrom(options);
      const args = [];
      return sendNativeQuery(`
        SELECT ${select}
          FROM ${esc.table(Model.tableName)}
          ${buildWhereQuery(criteria, args)}
      `, args, { Model, returnRows:true, limit, orderBy });
    };
    Model.findOne = (options={}) => {
      const { select, criteria, orderBy, limit } = getFindCriteriaFrom(options);
      const args = [];
      // from: https://dba.stackexchange.com/a/238287
      // TODO check if this truly limits us to one result or not (preferably with a permanent test)
      // TODO optimise this when only ID is supplied
      // TODO optimise this when only a single unique column is supplied (like ID case, but more general)
      return sendNativeQuery(`
        SELECT ${select}
          FROM ${esc.table(Model.tableName)}
          WHERE id = (
            SELECT id
              FROM ${esc.table(Model.tableName)}
              ${buildWhereQuery(criteria, args)}
          )
      `, args, { Model, returnSingleRow:true, limit, orderBy });
    };
    Model.update = criteria => {
      return {
        set: props => {
          props = withDefaultValues(Model, props);
          const args = [];
          const setQuery = buildSetQuery(Model, props, args);
          if(!setQuery) return 'TODO';

          return sendNativeQuery(`
            UPDATE ${esc.table(Model.tableName)}
              SET ${setQuery}
              ${buildWhereQuery(criteria, args)}
          `, args, { Model });
        },
      };
    };
    Model.updateOne = criteria => {
      // TODO this may fail if there are no matches, but if following waterline
      // spec it should not: https://sailsjs.com/documentation/reference/waterline-orm/models/update-one
      // It's unclear if this should trigger update of autoUpdatedAt timestamps
      return {
        set: props => {
          props = withDefaultValues(Model, props);
          const args = [];
          const setQuery = buildSetQuery(Model, props, args);
          if(!setQuery) return 'TODO';
          return sendNativeQuery(`
            UPDATE ${esc.table(Model.tableName)}
              SET ${setQuery}
              WHERE id = (
                SELECT id
                  FROM ${esc.table(Model.tableName)}
                  ${buildWhereQuery(criteria, args)}
              )
          `, args, { Model, single:true, fetch:true });
        },
      };
    };
  }
};

function buildSetQuery(Model, props, values) {
  const sets = [];

  Object
    .entries(props)
    .forEach(([ k, v ]) => {
      if(Model.attributes[k].type === 'json') {
        values.push(JSON.stringify(v));
      } else {
        values.push(v);
      }
      sets.push(`${esc.col(k)} = $${values.length}`);
    });

  return sets.join(', ');
}

function buildWhereQuery(criteria, args) {
  if(!criteria) {
    return '';
  }

  if(typeof criteria === 'object') {
    let argIdx = args.length;
    const wher = [];

    Object.entries(criteria)
        .forEach(([ k, v ]) => {
          if(v === null) {
            wher.push(`${esc.col(k)} IS NULL`);
          } else if(Array.isArray(v)) {
            args.push(v);
            wher.push(`${esc.col(k)}=ANY($${++argIdx})`);
          } else if(typeof v === 'object') {
            if(Object.keys(v).length !== 1) {
              throw new Error('TODO: ' + JSON.stringify({ k, v }));
            }
            Object.entries(v)
                .forEach(([ op, val ]) => {
                  if(op === '!=' && val === null) {
                    wher.push(`${esc.col(k)} IS NOT NULL`);
                  } else if(op === '!=' && Array.isArray(val)) {
                    // TODO need special handling for "=[...]"?
                    args.push(val);
                    wher.push(`NOT ( ${esc.col(k)} = ANY( $${++argIdx} ) )`);
                  } else {
                    args.push(val);
                    wher.push(`${esc.col(k)}${safeOp(op)}$${++argIdx}`);
                  }
                });
          } else {
            // TODO need special handling for "=[...]"?
            args.push(v);
            wher.push(`${esc.col(k)}=$${++argIdx}`);
          }
        });

    if(!wher.length) {
      return '';
    }

    return `WHERE ${wher.join(' AND ')}`;
  }

  args.push(criteria);
  return `WHERE id=$${args.length}`;
}

function buildValuesQuery(Model, cols, props, values) {
  const q = [];

  cols.forEach(k => {
    let v = props[k];
    values.push(v);
    q.push(`$${values.length}`);
  });

  return `(${q.join(', ')})`;
}

function buildColumnNamesQuery(cols) {
  return `( ${cols.map(esc.col).join(', ')} )`;
}

function buildOrderByQuery(orderBy) {
  if(!orderBy) {
    return '';
  }
  const parts = orderBy.trim().split(/\s+/);
  let dir = '';
  switch(parts.length) {
    case 0: return '';
    case 1: /* ok */ break;
    case 2: dir = parts[1].toUpperCase(); break;
    default: throw new Error(`Unexpected extras in ORDER BY clause: "${orderBy}"`);
  }
  if(dir && !['ASC', 'DESC'].includes(dir)) {
    throw new Error(`Unexpected direction provided in ORDER BY clause: "${orderBy}"`);
  }
  return ` ORDER BY ${esc.col(parts[0])} ${dir}`;
}

function buildLimitQuery(limit) {
  return limit === undefined ? '' : ` LIMIT ${esc.num(limit)}`;
}

/**
 * Map sails error names to postgres error codes.
 */
function getErrorCodesFor(sailsErrorName) {
  switch(sailsErrorName) {
    case 'E_UNIQUE': return [ 23505 ];
    default: return []; //throw new Error(`Sails->Postgres code mapping not configured for "${sailsErrorName}"`);
  }
}

function safeOp(op) {
  switch(op) {
    case '<':
    case '>':
    case '<=':
    case '>=':
    case '!=':
      return op;
    default: throw new Error(`Unrecognised op in criteria: ${op}`);
  }
}

function withTimestampsCast(row) {
  if(row) {
    // Special custom handling for created_at and updated_at
    if(row.created_at) {
      row.created_at = Number(row.created_at);
    }
    if(row.updated_at) {
      row.updated_at = Number(row.updated_at);
    }
  }
  return row;
}

function withSelectedValuesCast(Model, row) {
  if(!Model) {
    throw new Error('No model supplied!  ' + JSON.stringify(row, null, 2));
  }
  if(row) {
    row = withTimestampsCast(row);

    Object.entries(row)
      .forEach(([ k, v ]) => {
        if(v === undefined || v === null) {
          const { allowNull, type } = Model.attributes[k];
          if(!allowNull) {
            // > The string, number, and boolean data types do not accept null as a value when creating or updating
            // > records. In order to allow a null value to be set, you can toggle the allowNull flag on the
            // > attribute. Note that the allowNull flag is only valid on the data types listed above. It is not
            // > valid on attributes with types json or ref, any associations, or any primary key attributes.
            // see: https://sailsjs.com/documentation/concepts/models-and-orm/attributes#allow-null
            switch(type) {
              case 'string':  row[k] = '';    break;
              case 'number':  row[k] = 0;     break;
              case 'boolean': row[k] = false; break;
            }
          }
        }
      });
  }

  return row;
}

function withDefaultValues(Model, props, { creating }={}) {
  if(!Model) {
    throw new Error('No model supplied!  ' + JSON.stringify(props, null, 2));
  }
  if(props) {
    Object.entries(Model.attributes)
      .forEach(([ attr, cfg ]) => {
        if(creating && props[attr] === undefined) {
          const { defaultsTo } = cfg;
          if(defaultsTo !== undefined) {
            props[attr] = cloneDeep(defaultsTo);
          }
        }
        // FIXME this check doesn't look quite correct for autoUpdatedAt attributes which are undefined here
        if((creating && props[attr] === undefined) || props[attr] === null) {
          const { allowNull, type, autoCreatedAt, autoUpdatedAt } = cfg;
          if(autoCreatedAt) {
            if(creating) {
              props[attr] = NOW;
            }
          } else if(autoUpdatedAt) {
            props[attr] = NOW;
          } else if(!allowNull) {
            // > The string, number, and boolean data types do not accept null as a value when creating or updating
            // > records. In order to allow a null value to be set, you can toggle the allowNull flag on the
            // > attribute. Note that the allowNull flag is only valid on the data types listed above. It is not
            // > valid on attributes with types json or ref, any associations, or any primary key attributes.
            // see: https://sailsjs.com/documentation/concepts/models-and-orm/attributes#allow-null
            switch(type) {
              case 'string':  props[attr] = '';    break;
              case 'number':  props[attr] = 0;     break;
              case 'boolean': props[attr] = false; break;
            }
          }
        }
      });
  }

  return props;
}

function getFindCriteriaFrom(options) {
  let select = '*', criteria, orderBy, limit;

  if(Object.keys(options).some(it => ['select'].includes(it))) {
    if(options.select) {
      select = options.select.map(esc.col).join(', ');
    }
    if(options.where) {
      criteria = options.where;
    }
    if(options.sort) {
      orderBy = options.sort;
    }
    if(options.limit) {
      limit = options.limit;
    }
  } else {
    criteria = options;
  }

  return { select, criteria, orderBy, limit };
}
