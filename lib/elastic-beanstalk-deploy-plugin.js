/*jshint node: true*/

var fs                = require('fs-promise');
var path              = require('path');
var glob              = require('glob');
var RSVP              = require('rsvp');
var exec              = RSVP.denodeify(require('child_process').exec);
var AWS               = require('aws-sdk');
var ElasticBeanstalk  = require('./aws/elastic-beanstalk');
var Promise           = require('ember-cli/lib/ext/promise');
var DeployPlugin      = require('ember-cli-deploy-plugin');
var md5Hash           = require('./md5-hash');

const CONFIG_ENV_MAPPING = {
  FASTBOOT_EB_APPLICATION: 'applicationName',
  FASTBOOT_EB_ENVIRONMENT: 'environmentName',
  FASTBOOT_EB_BUCKET: 'bucket'
};

module.exports = DeployPlugin.extend({
  defaultConfig: {
    environment: 'production',
    outputPath: path.join('tmp', 'fastboot-dist'),
    zipPath: path.join('tmp', 'fastboot-dist.zip')
  },

  requiredConfig: ['environment', 'bucket'],

  configure: function() {
    var config = this.pluginConfig;

    // Copy environment variables to the config if defined.
    for (var key in CONFIG_ENV_MAPPING) {
      if (process.env[key]) {
        config[CONFIG_ENV_MAPPING[key]] = process.env[key];
      }
    }

    this._super.configure.apply(this, arguments);
  },

  build: function() {
    var outputPath = this.readConfig('outputPath');
    var self = this;

    return this.buildFastBoot(outputPath)
      .then(function(files) {
        return {
          fastbootDistDir: outputPath,
          fastbootDistFiles: files || []
        };
      })
      .catch(function(error) {
        self.log('build failed', { color: 'red' });
        return Promise.reject(error);
      });
  },

  buildFastBoot: function(outputPath) {
    var buildEnv   = this.readConfig('environment');

    this.log('building fastboot app to `' + outputPath + '` using buildEnv `' + buildEnv + '`...', { verbose: true });

    process.env.EMBER_CLI_FASTBOOT = true;

    var Builder  = this.project.require('ember-cli/lib/models/builder');

    var builder = new Builder({
      ui: this.ui,
      outputPath: outputPath,
      environment: buildEnv,
      project: this.project
    });

    return builder.build()
      .finally(function() {
        process.env.EMBER_CLI_FASTBOOT = false;
        return builder.cleanup();
      })
      .then(this._logSuccess.bind(this, outputPath));
  },

  didBuild: function(context) {
    // Rewrite FastBoot index.html assets
    try {
      var browserAssetMap = JSON.parse(fs.readFileSync(context.distDir + '/assets/assetMap.json'));
      var fastBootAssetMap = JSON.parse(fs.readFileSync(context.fastbootDistDir + '/assets/assetMap.json'));
      var prepend = browserAssetMap.prepend;

      var indexHTML = fs.readFileSync(context.fastbootDistDir + '/index.html').toString();
      var newAssets = browserAssetMap.assets;
      var oldAssets = fastBootAssetMap.assets;

      for (var key in oldAssets) {
        var value = oldAssets[key];
        indexHTML = indexHTML.replace(prepend + value, prepend + newAssets[key]);
      }

      fs.writeFileSync(context.fastbootDistDir + '/index.html', indexHTML);
    } catch(e) {
      this.log('unable to rewrite assets: ' + e.stack, { verbose: true });
    }
  },

  willUpload: function(context){
    var self = this;
    var zipPath = this.readConfig('zipPath');
    var dir = context.fastbootDistDir;

    zipPath = path.resolve(zipPath);

    this.log('zipping ' + dir + ' into ' + zipPath, { verbose: true });

    return exec("zip -r " + zipPath + " fastboot-dist deploy-dist", {
      cwd: path.dirname(dir),
    })
      .then(function(){
        var zipBuf = fs.readFileSync(zipPath);
        var hash = md5Hash(zipBuf);
        var hashedZip = path.join(path.dirname(zipPath), 'fastboot-dist-' + hash + '.zip');

        context.fastbootHashedZip = hashedZip;

        return fs.rename(zipPath, hashedZip)
          .then(function() {
            self.log("created " + hashedZip, { verbose: true });
            return {
              hashedZip: hashedZip
            };
          });
      });
  },

  upload: function(context) {
    var bucket = this.readConfig('bucket');
    var file = context.hashedZip;

    this.log('uploading ' + file + ' to ' + bucket, { verbose: true });

    var key = path.basename(file);
    context.elasticBeanstalkS3Key = key;

    var s3 = new AWS.S3({
      params: {
        Bucket: bucket
      }
    });

    return new Promise(function(resolve, reject) {
      var params = { Key: key };
      params.Body = fs.createReadStream(file);
      s3.upload(params, function(err, data) {
        if (err) {
          reject(err);
        }

        resolve(data);
      });
    });
  },

  didUpload: function(context) {
    var environmentName = this.readConfig('environmentName');
    var applicationName = this.readConfig('applicationName');
    var bucket = this.readConfig('bucket');
    var name = this.project.name();
    var key = context.elasticBeanstalkS3Key;

    var eb = new ElasticBeanstalk();

    this.log('activating build on Elastic Beanstalk environment ' + environmentName);

    this.log('settng FASTBOOT_APP_NAME to ' + name, { verbose: true });
    this.log('settng FASTBOOT_S3_BUCKET to ' + bucket, { verbose: true });
    this.log('settng FASTBOOT_S3_KEY to ' + key, { verbose: true });

    var env = {
      FASTBOOT_APP_NAME: name,
      FASTBOOT_S3_BUCKET: bucket,
      FASTBOOT_S3_KEY: key
    };

    return eb.updateEnvironment(applicationName, environmentName, env);
  },

  _logSuccess: function(outputPath) {
    var self = this;
    var files = glob.sync('**/**/*', { nonull: false, nodir: true, cwd: outputPath });

    if (files && files.length) {
      files.forEach(function(path) {
        self.log('✔  ' + path, { verbose: true });
      });
    }
    self.log('fastboot build ok', { verbose: true });

    return Promise.resolve(files);
  }
});
