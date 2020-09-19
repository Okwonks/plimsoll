const fs = require('fs');
const path = require('path');
const plimsoll = require('./plimsoll');

module.exports = function(sails) {
  const { config } = sails;

  const { pool } = config.datastores.default;

  const modelSources = {};

  fs.readdirSync(config.paths.models)
    .filter(f => f.endsWith('.js'))
    .forEach(f => {
      const modelName = f.replace(/\.js$/, '');
      modelSources[modelName] = require(path.join(config.paths.models, f));
    });

  const { models, sendNativeQuery, transaction } = plimsoll(pool, modelSources, config.models.attributes);

  sails.models = models;
  sails.sendNativeQuery = sendNativeQuery;

  if(config.globals.models) {
    Object.entries(models)
      .forEach(([ modelName, model ]) => {
        global[modelName] = model;
      });
  }

  sails.getDatastore = () => {
    return { manager:{ pool }, sendNativeQuery, transaction };
  };

  return {};
};
