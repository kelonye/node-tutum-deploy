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
 * Init deployment
 */
Program.prototype.up = function(){

  var self = this;
  this.loadConf(function(err){
    if (err) return debug(err.message);
    self.deploy();
  });

};


/**
 * Init status check
 */
Program.prototype.ps = function(){

  var self = this;
  this.loadConf(function(err){
    if (err) return debug(err.message);
    self.status();
  });

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

  if (!doc.cluster) return done(new Error('tutum conf parse error: cluster info required'));
  if (!doc.services) return done(new Error('tutum conf parse error: services info required;'));

  this.cluster = doc.cluster;
  this.services = doc.services;

  if (this.cluster && this.cluster.nodes){
    this.cluster.target_num_nodes = this.cluster.nodes;
    delete this.cluster.nodes;
  }

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
Program.prototype.status = function() {

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // cluster
  batch.push(this.getCluster.bind(this));

  // services
  this.services.forEach(function(service){
    batch.push(self.getService.bind(self, service));
  });
  
  batch.end(function(err){
    if (err) return debug('status check failed: %s', err.message);
  });

};


/**
 * Deploy.
 */
Program.prototype.deploy = function(){

  var self = this;

  var batch = new Batch;
  
  batch.concurrency(1);

  // cluster
  batch.push(this.getCluster.bind(this));
  batch.push(this.createCluster.bind(this));
  batch.push(this.deployCluster.bind(this));

  // services
  this.services.forEach(function(service){
    
    batch.push(self.buildImage.bind(self, service));
    batch.push(self.pushImage.bind(self, service));
    batch.push(self.getService.bind(self, service));
    batch.push(self.createService.bind(self, service));
    batch.push(self.startService.bind(self, service));
    batch.push(self.updateService.bind(self, service));
    batch.push(self.redeployService.bind(self, service));

  });
  
  batch.end(function(err){
    if (err) return debug('deployment failed: %s', err.message);
    debug('deployment successful');
  });

};


/**
 * Get cluster details.
 */
Program.prototype.getCluster = function(done) {

  if (!this.cluster) return done();

  debug('getting cluster: %s', this.cluster.name);

  var self = this;
  self
    .get('/nodecluster/?name='+this.cluster.name)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error getting cluster '+self.cluster.name+': '+response.text));
      self.cluster.tutum = response.body.objects[0];
      if (!self.cluster.tutum) return self.getRegion.call(self, done);
      debug('cluster %s state: %s', self.cluster.name, self.cluster.tutum.state);
      var state = self.cluster.tutum.state;
      if (state == 'Terminated' || state == 'Terminating') return done(new Error('error getting cluster '+self.cluster.name+': cluster is '+state));
      done();
    });

};


/**
 * Get cluster region.
 */
Program.prototype.getRegion = function(done) {
    
  if (!this.cluster) return done();

  if (/^\/.+/.test(this.cluster.region)) return done();

  var self = this;

  debug('getting region: %s', this.cluster.region);

  self
    .get('/region/?name='+this.cluster.region)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error getting region: '+response.text));

      var region = response.body.objects[0];
      if (!region) return done(new Error('region not found'));
      self.cluster.region = region.resource_uri;

      var type = region.node_types.filter(function(t){
        var rgx = new RegExp(self.cluster.type+'/$');
        return rgx.test(t);
      })[0];
      if (!region) return done(new Error('region not found'));
      self.cluster.node_type = type;
      delete self.cluster.type;

      done();
    });

};


Program.prototype.createCluster = function(done) {

  var self = this;

  if (!this.cluster) return done();

  if (this.cluster.tutum){
    debug('%s cluster already created, skipping', this.cluster.name);
    return done();
  };

  debug('creating cluster: %s', this.cluster.name);

  var payload = clone(this.cluster);
  delete payload.tutum;

  self
    .post('/nodecluster/')
    .send(payload)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 201) return done(new Error('error creating '+self.cluster.name+' cluster: '+response.text));
      self.cluster.tutum = response.body;
      done();
    });

};


Program.prototype.deployCluster = function(done) {

  var self = this;

  if (!this.cluster) return done();
  
  if (this.cluster.tutum.state != 'Init'){
    debug('%s cluster is in the %s state, skipping', this.cluster.name, this.cluster.tutum.state);
    return done();
  };

  debug('deploying cluster: %s', this.cluster.name);

  self
    .post('/nodecluster/'+this.cluster.tutum.uuid+'/deploy/')
    .send({})
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 202) return done(new Error('error deploying '+self.cluster.name+' cluster: '+response.text));
      done();
    });

};


Program.prototype.buildImage = function(service, done) {

  if (this.cluster.build === false || !service.build) return done();

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


Program.prototype.pushImage = function(service, done) {

  if (this.cluster.build === false || !service.build) return done();

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
      if (service.tutum){
        debug('service %s state: %s', service.name, service.tutum.state);
      }
      done();
    });

};


Program.prototype.createService = function(service, done) {

  var self = this;

  if (service.tutum){
    debug('create service: service %s is already created, skipping', service.name);
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


Program.prototype.startService = function(service, done){

  var state = service.tutum.state;
  if (!(state == 'Init' || state == 'Stop')) return done();

  debug('starting service: %s(%s)', service.name, service.tutum.uuid);

  var self = this;

  self
    .post('/service/'+service.tutum.uuid+'/start/')
    .send(service)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 202) return done(new Error('error starting '+service.name+' service: '+response.text));
      setTimeout(done, 2000);
    });

};


Program.prototype.updateService = function(service, done){

  debug('update service: updating service: %s(%s)', service.name, service.tutum.uuid);

  var self = this;

  var uuid = service.tutum.uuid;
  delete service.tutum;

  self
    .patch('/service/'+uuid)
    .send(service)
    .end(function(err, response){
      if (err) return done(err);
      if (response.status !== 200) return done(new Error('error updating '+service.name+' service: '+response.text));
      service.tutum = response.body;
      done();
    });

};


Program.prototype.redeployService = function(service, done){

  if (service.tutum.state != 'Running') return done();

  debug('redeploying service: %s(%s)', service.name, service.tutum.uuid);

  var self = this;

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
