#!/usr/bin/env node

// log

process.env.DEBUG = 'tutum:*';

// modules

var Batch =  require('batch');
var request = require('superagent');
var debug = require('debug')('tutum:deploy');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');
var read = fs.readFileSync;
var join = require('path').join;
var yaml = require('js-yaml');
var clone = require('component-clone');


/**
 * Expose.
 */
module.exports = Program;


/**
 * Program
 */
function Program(){

  this.cwd = process.cwd();
  this.apiVersion = 1;
  this.apiBaseURL = 'https://dashboard.tutum.co/api/v'+this.apiVersion;

};


/**
 * Load conf
 */
Program.prototype.loadConf = function(done){

  var conf;

  try {
    var conf = read(join(this.cwd, 'tutum.yaml'), 'utf8');
  } catch (e) {
    return done(new Error('tutum conf read error: '+e.message));
  }

  for (var setting in process.env){
    var match = setting.match(/^TUTUM_(\w+)/);
    if (match){
      var rgx = new RegExp('{{'+match[1]+'}}', 'g');
      var val = process.env[setting];
      if (!val) return done(new Error('%s setting is undefined', setting));
      conf = conf.replace(rgx, val);
    }
  }

  try {
    var doc = yaml.safeLoad(conf);
  } catch (e) {
    return done(new Error('tutum conf parse error: '+e.message));
  }

  this.clusters = doc.clusters || [];
  this.nodes = doc.nodes || [];
  this.services = doc.services || [];

  // clusters
  this.clusters.forEach(function(cluster){
    if (cluster && cluster.nodes){
      cluster.target_num_nodes = cluster.nodes;
      delete cluster.nodes;
    }
  });

  // nodes
  this.nodes.forEach(function(node){
  });
  
  this.services.forEach(function(service){
    if (service.containers){
      service.target_num_containers = service.containers;
      delete service.containers;
    }
    if (service.env){
      service.container_envvars = [];
      for (var k in service.env){
        service.container_envvars.push({
          key: k,
          value: service.env[k]
        });
      }
      delete service.env;
    }
    if (service.ports){
      service.container_ports = service.ports;
      delete service.ports;
    }
  });

  // debug(JSON.stringify(doc, null, 2));

  done();

};


/**
 * Check services status.
 */
Program.prototype.ps = function() {

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // conf
  batch.push(this.loadConf.bind(this));

  // cluster
  batch.push(this.getCluster.bind(this));

  // services
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.services.forEach(function(service){
      batch.push(self.getService.bind(self, service));
    });
    batch.end(done);
  });

  batch.end(function(err){
    if (err) return debug('status check failed: %s', err.message);
  });

};


/**
 * Build images.
 */
Program.prototype.buildImages = function() {

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // conf
  batch.push(this.loadConf.bind(this));

  // services
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.services.forEach(function(service){
      batch.push(self.buildImage.bind(self, service));
    });
    batch.end(done);
  });

  batch.end(function(err){
    if (err) return debug('build failed: %s', err.message);
  });

};


/**
 * Build image for `service`.
 * 
 * @param [Object] service - service conf
 */
Program.prototype.buildImage = function(service, done) {

  if (!service.build) return done();

  var script = 'docker build -t '+service.image+' '+join(this.cwd, service.build);

  debug('building %s', service.image);

  var cmd = spawn('bash', ['-c', script]);
  cmd.stdout.setEncoding('utf8');
  cmd.stdout.on('data', function (data) {
    debug(data);
  });
  cmd.stderr.on('data', function (data) {
    debug('stderr: ' + data);
  });
  cmd.on('close', function (code) {
    done();
  });

};


/**
 * Push images.
 */
Program.prototype.pushImages = function() {

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // conf
  batch.push(this.loadConf.bind(this));

  // services
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.services.forEach(function(service){
      batch.push(self.pushImage.bind(self, service));
    });
    batch.end(done);
  });

  batch.end(function(err){
    if (err) return debug('push failed: %s', err.message);
  });

};


/**
 * Push image for `service` to registry.
 * 
 * @param [Object] service - service conf
 */
Program.prototype.pushImage = function(service, done) {

  if (!service.build) return done();

  debug('pushing %s', service.image);

  var cmd = spawn('bash', ['-c', 'docker push '+ service.image]);
  cmd.stdout.setEncoding('utf8');
  cmd.stdout.on('data', function (data) {
    debug(data);
  });
  cmd.stderr.on('data', function (data) {
    debug('stderr: ' + data);
  });
  cmd.on('close', function (code) {
    done();
  });

};


/**
 * Deploy
 */
Program.prototype.up = function(){

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // conf
  batch.push(this.loadConf.bind(this));

  // clusters
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.clusters.forEach(function(cluster){
      batch.push(self.getCluster.bind(self, cluster));
      batch.push(self.getClusterRegion.bind(self, cluster));
      batch.push(self.createCluster.bind(self, cluster));
      batch.push(self.getClusterTags.bind(self, cluster));
      batch.push(self.deployCluster.bind(self, cluster));
    });
    batch.end(done);
  });

  // nodes
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.nodes.forEach(function(node){
      batch.push(self.getNode.bind(self, node));
      batch.push(self.createNode.bind(self, node));
      batch.push(self.getNodeTags.bind(self, node));
      batch.push(self.deployNode.bind(self, node));
    });
    batch.end(done);
  });

  // services
  batch.push(function(done){
    var batch = new Batch;
    batch.concurrency(1);
    self.services.forEach(function(service){
      batch.push(self.getService.bind(self, service));
      batch.push(self.createService.bind(self, service));
      batch.push(self.startService.bind(self, service));
      batch.push(self.updateService.bind(self, service));
      batch.push(self.redeployService.bind(self, service));
    });
    batch.end(done);
  });

  batch.end(function(err){
    if (err) return debug('deployment failed: %s', err.message);
    debug('deployment successful');
  });

};


/**
 * Get `cluster` details and invoke `done(err)`.
 *
 * @param {Object} cluster - cluster conf
 * @param {Function} done - callback
 */
Program.prototype.getCluster = function(cluster, done) {

  debug('getting cluster: %s', cluster.name);

  var self = this;
  self
    .get('/nodecluster/?name='+cluster.name)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error getting cluster '+cluster.name+': '+response.text));
      cluster.tutum = response.body.objects[0];
      debug('cluster %s state: %s', cluster.name, cluster.tutum.state);
      var state = cluster.tutum.state;
      if (state == 'Terminated' || state == 'Terminating') return done(new Error('error getting cluster '+cluster.name+': cluster is '+state));
      done();
    });

};


/**
 * Get cluster region and invoke `done(err)`.
 *
 * @param {Object} cluster - cluster conf
 * @param {Function} done - callback
 */
Program.prototype.getClusterRegion = function(cluster, done) {

  if (cluster.tutum) return done(); // we only fetch the region when we need to create the cluster
  if (/^\/.+/.test(cluster.region)) return done();

  var self = this;

  debug('getting region: %s', cluster.region);

  self
    .get('/region/?name='+cluster.region)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error getting region: '+response.text));

      var region = response.body.objects[0];
      if (!region) return done(new Error('region not found'));
      cluster.region = region.resource_uri;

      var type = region.node_types.filter(function(t){
        var rgx = new RegExp(cluster.type+'/$');
        return rgx.test(t);
      })[0];
      if (!region) return done(new Error('region not found'));
      cluster.node_type = type;
      delete cluster.type;

      done();
    });

};


/**
 * Create `cluster` if none existent and invoke `done(err)`.
 * 
 * @param {Object} cluster - cluster conf
 * @param {Function} done - callback
 */
Program.prototype.createCluster = function(cluster, done) {

  var self = this;

  if (cluster.tutum){
    debug('cluster %s already created, skipping', cluster.name);
    return done();
  };

  debug('creating cluster: %s', cluster.name);

  var payload = clone(cluster);
  delete payload.tutum;

  self
    .post('/nodecluster/')
    .send(payload)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 201) return done(new Error('error creating '+cluster.name+' cluster: '+response.text));
      cluster.tutum = response.body;
      done();
    });

};


/**
 * Deploy `cluster` if it's still in the Init state and invoke `done(err)`.
 *
 * @param {Object} cluster - cluster conf
 * @param {Function} done - callback
 */
Program.prototype.deployCluster = function(cluster, done) {

  var self = this;

  if (cluster.tutum.state != 'Init'){
    debug('cluster %s is in the %s state, skipping', cluster.name, cluster.tutum.state);
    return done();
  };

  debug('deploying cluster: %s', cluster.name);

  self
    .post('/nodecluster/'+cluster.tutum.uuid+'/deploy/')
    .send({})
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 202) return done(new Error('error deploying '+cluster.name+' cluster: '+response.text));
      done();
    });

};


/**
 * Get cluster `tag` for services lookup.
 *
 * @param {Object} cluster - cluster conf
 * @param {Function} done - callback
 */
Program.prototype.getClusterTags = function(cluster, done) {
    
  var self = this;

  debug('getting tags for cluster %s', cluster.name);

  self
    .get('/nodecluster/'+cluster.tutum.uuid+'/tags/')
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error fetching tags: '+ response.text));
      self.addTags(response.body.objects);
      done();
    });

};


/**
 * Add `tags` for services lookup.
 *
 * @param {Array} tags - list of tags
 */
Program.prototype.addTags = function(tags) {
  
  var self = this;
  self.tags = self.tags || {};

  tags = tags || [];

  tags.forEach(function(tag){
    self.tags[tag.name] = self.tags[tag.name] || [];
    self.tags[tag.name].push(tag.resource_uri);
  });

};


/**
 * Get custom `node` details and invoke `done(err)`.
 *
 * @param {Object} node - node conf
 * @param {Function} done - callback
 */
Program.prototype.getNode = function(node, done) {

  debug('getting node: %s', node.uuid);

  var self = this;
  self
    .get('/node/'+node.uuid+'/')
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error getting node '+response.status+': '+node.uuid+': '+response.text));
      node.tutum = response.body;
      debug('node %s state: %s', node.uuid, node.tutum.state);
      var state = node.tutum.state;
      if (state == 'Terminated' || state == 'Terminating') return done(new Error('error getting node '+node.uuid+': cluster is '+state));
      done();
    });

};


/**
 * Create `node` if non-existence and invoke `done(err)`.
 * 
 * @param {Object} node - node conf
 * @param {Function} done - callback
 */
Program.prototype.createNode = function(node, done) {
  
  // not yet supported
  // link custom node from web interface
  
  done();

};


/**
 * Update `node` and invoke `done(err)`.
 * Current supported fields are `tags`,.
 * 
 * @param {Object} node - node conf
 * @param {Function} done - callback
 */
Program.prototype.updateNode = function(node, done) {

  debug('updating node: %s', node.tutum.uuid);

  var self = this;
  self
    .patch('/node/'+node.tutum.uuid+'/')
    .send({
      tags: node.tags
    })
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 201) return done(new Error('error updating node '+node.tutum.uuid+': '+response.text));
      node.tutum = response.body;
      done();
    });

};


/**
 * Get node `tag` for services lookup.
 *
 * @param {Object} node - node conf
 * @param {Function} done - callback
 */
Program.prototype.getNodeTags = function(node, done) {
    
  var self = this;

  debug('getting tags for node %s', node.tutum.uuid);

  self
    .get('/node/'+node.tutum.uuid+'/tags/')
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error fetching node tags: '+ response.text));
      self.addTags(response.body.objects);
      done();
    });

};


/**
 * Deploy `node` if it's still in the Init state and invoke `done(err)`.
 *
 * @param {Object} node - node conf
 * @param {Function} done - callback
 */
Program.prototype.deployNode = function(node, done) {

  var self = this;

  if (node.tutum.state != 'Init'){
    debug('node %s is in the %s state, skipping', node.tutum.uuid, node.tutum.state);
    return done();
  };

  debug('deploying node: %s', node.tutum.uuid);

  self
    .post('/node/'+node.tutum.uuid+'/deploy/')
    .send({
    })
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error deploying node '+node.tutum.uuid+': '+response.text));
      done();
    });

};


/**
 * Get `service` details and invoke `done(err)`.
 *
 * @param {Object} service - service conf
 * @param {Function} done - callback
 */
Program.prototype.getService = function(service, done) {

  var self = this;
  
  debug('getting service %s', service.name);

  self
    .get('/service/?name='+service.name)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error fetching services: '+ response.text));
      service.tutum = response.body.objects.filter(function(s){
        return !(s.state == 'Terminated' || s.state == 'Terminating');
      })[0];
      var tags = [];
      service.tags.forEach(function(tagName){
        (self.tags[tagName] || []).forEach(function(tag){
          tags.push({
            name: tagName,
            resource_uri: tag
          });
        });
      });
      service.tags = tags;
      if (service.tutum){
        debug('service %s state: %s', service.name, service.tutum.state);
      }
      done();
    });

};


/**
 * Create `service` if non-existent and invoke `done(err)`.
 *
 * @param {Object} service - service conf
 * @param {Function} done - callback
 */
Program.prototype.createService = function(service, done) {

  var self = this;

  if (service.tutum){
    debug('service %s is already created, skipping', service.name);
    return done();
  }

  debug('creating service: %s', service.name);

  var payload = clone(service);

  if (payload.require){
    payload.linked_to_service = payload.require.map(function(link){
      var s = self
        .services
        .filter(function(s){
          return s.name == link;
        })[0];
      return {
        to_service: '/api/v'+self.apiVersion+'/service/'+s.tutum.uuid+'/',
        name: link
      };
    });
  }

  delete payload.build;
  delete payload.tutum;
  delete payload.require;

  // debug(JSON.stringify(payload, null, 2));

  self
    .post('/service/')
    .send(payload)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 201) return done(new Error('error creating '+service.name+' service: '+response.text));
      service.tutum = response.body;
      setTimeout(done, 2000);
    });

};


/**
 * Start `service` if it's been stopped and invoke `done(err)`.
 *
 * @param {Object} service - service conf
 * @param {Function} done - callback
 */
Program.prototype.startService = function(service, done){

  var self = this;
  var state = service.tutum.state;

  if (state == 'Running'){
    debug('service %s is running, skipping', service.name);
    return done();
  }

  debug('starting service: %s(%s)', service.name, service.tutum.uuid);

  self
    .post('/service/'+service.tutum.uuid+'/start/')
    .send(service)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 202) return done(new Error('error starting '+service.name+' service: '+response.text));
      setTimeout(done, 2000);
    });

};


/**
 * Update `service` and invoke `done(err)`.
 * Updateable fields are `tags`,.
 *
 * @param {Object} service - service conf
 * @param {Function} done - callback
 */
Program.prototype.updateService = function(service, done){

  var self = this;

  debug('update service: updating service: %s(%s)', service.name, service.tutum.uuid);

  var uuid = service.tutum.uuid;
  delete service.tutum;

  self
    .patch('/service/'+uuid)
    .send({
      tags: service.tags
    })
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error updating '+service.name+' service: '+response.text));
      service.tutum = response.body;
      done();
    });

};


/**
 * Restart `service` and invoke `done(err)`.
 *
 * @param {Object} service - service conf
 * @param {Function} done - callback
 */
Program.prototype.redeployService = function(service, done){

  var self = this;

  if (service.tutum.state !== 'Running'){
    debug('service %s is not running, skipping', service.name);
    return done();
  }

  debug('redeploying service: %s(%s)', service.name, service.tutum.uuid);

  self
    .post('/service/'+service.tutum.uuid+'/redeploy/')
    .send(service)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 202) return done(new Error('error redeploying '+service.name+' service: '+response.text));
      done();
    });

};


Program.prototype.get = function(url){

  return request
    .get(this.url(url))
    .set(this.headers());

};


Program.prototype.post = function(url){

  return request
    .post(this.url(url))
    .set(this.headers());

};


Program.prototype.patch = function(url){

  return request
    .patch(this.url(url))
    .set(this.headers());

};


Program.prototype.headers= function(){
  return {
    'Content-Type': 'application/json',
    Authorization: 'ApiKey '+process.env.TUTUM_USER+':'+process.env.TUTUM_APIKEY,
    Accept: 'application/json'
  };
};


Program.prototype.url = function(url){
  return this.apiBaseURL+url;
};
