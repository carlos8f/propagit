var upnode = require('upnode');
var pushover = require('pushover');
var mkdirp = require('mkdirp');
var spawn = require('child_process').spawn;
var seq = require('seq');

var fs = require('fs');
var path = require('path');
var Stream = require('stream').Stream;

module.exports = function (secret) {
    return new Propagit(secret);
};

var logger = function (uid) {
    return function (name, buf) {
        if (name === 'data') {
            var lines = buf.toString().split('\n');
            lines.forEach(function (line) {
                console.log('[' + uid + '] ' + line);
            });
        }
    };
};

function Propagit (opts) {
    if (typeof opts === 'string') {
        opts = { secret : opts };
    }
    
    this.readable = true;
    this.secret = opts.secret;
    this.middleware = [];
    
    var base = opts.basedir || process.cwd();
    this.repodir = path.resolve(opts.repodir || base + '/repos');
    this.deploydir = path.resolve(opts.deploydir || base + '/deploy');
    
    if (opts.hub) this.connect(opts.hub);
}

Propagit.prototype = new Stream;

Propagit.prototype.connect = function (hub) {
    var self = this;
    
    if (typeof hub === 'string') {
        hub = {
            host : hub.split(':')[0],
            port : hub.split(':')[1],
        };
    }
    
    self.hub = upnode.connect(hub, function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) self.emit('error', err)
            else {
                self.ports = res.ports;
                self.gitUri = 'http://' + hub.host + ':' + self.ports.git;
                conn.emit('up', res);
            };
        });
    });
    
    [ 'up', 'reconnect', 'down' ].forEach(function (name) {
        self.hub.on(name, self.emit.bind(self, name));
    });
    
    return self;
};

Propagit.prototype.use = function (fn) {
    this.middleware.push(fn);
};

Propagit.prototype.listen = function (controlPort, gitPort) {
    var self = this;
    mkdirp(self.repodir);
    self.drones = [];
    self.ports = {
        control : controlPort,
        git : gitPort,
    };
    
    var server = upnode(function (remote, conn) {
        this.auth = function (secret, cb) {
            if (typeof cb !== 'function') return
            else if (self.secret === secret) {
                cb(null, self.createService(remote, conn));
            }
            else cb('ACCESS DENIED')
        };
    }).listen(controlPort);
    
    if (!self._servers) self._servers = [];
    self._servers.push(server);
    
    self.close = function () {
        self._servers.forEach(function (s) {
            s.close();
        });
    };
    
    var repos = self.repos = pushover(self.repodir);
    repos.on('push', function (repo) {
        self.emit('push', repo);
        self.drones.forEach(function (drone) {
            drone.fetch(repo, logger(drone.id));
        });
    });
    repos.listen(gitPort);
    
    return self;
};

Propagit.prototype.getDrones = function (opts) {
    var self = this;
    if (!opts) opts = {};
    if (opts.drone === '*') opts.drone = { test : function () { return true } };
    
    var names = opts.drone ? [ opts.drone ] : opts.drones;
    var ids = self.drones.map(function (d) { return d.id });
    
    if (opts.drone && typeof opts.drone.test === 'function') {
        return self.drones.filter(function (d) {
            return opts.drone.test(d.id);
        });
    }
    if (names) {
        return names.map(function (name) {
            var ix = ids.indexOf(name);
            return self.drones[ix];
        }).filter(Boolean);
    }
    else {
        var ix = Math.floor(Math.random() * self.drones.length);
        var drone = self.drones[ix];
        return drone ? [ drone ] : [];
    }
};

Propagit.prototype.createService = function (remote, conn) {
    var self = this;
    
    var service = { ports : self.ports };
    
    service.drones = function (cb) {
        if (typeof cb !== 'function') return;
        cb(self.drones.map(function (d) { return d.id }));
    };
    
    service.ps = function (emit) {
        var drones = self.drones;
        var pending = drones.length;
        if (pending === 0) emit('end')
        
        drones.forEach(function (drone) {
            emit('addr', drone.id, drone.addr);
            drone.ps(function (ps) {
                emit('data', drone.id, ps);
                if (--pending === 0) emit('end');
            });
        });
    };
    
    service.deploy = function (opts, cb) {
        if (!opts.drone) opts.drone = '*';
        
        var drones = self.getDrones(opts);
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var errors = [];
        
        drones.forEach(function (drone) {
            self.emit('deploy', drone.id, opts);
            drone.fetch(opts.repo, function (code, sig) {
                if (code) {
                    pending --;
                    var err = new Error(
                        'git fetch exited with error code ' + code
                    );
                    err.command = 'fetch';
                    err.drone = drone.id;
                    err.code = code;
                    err.signal = sig;
                    errors.push(err);
                }
                else drone.deploy(opts, function (code, sig) {
                    pending --;
                    if (code) {
                        var err = new Error(
                            'deploy exited with error code ' + code
                        );
                        err.command = 'deploy';
                        err.drone = drone.id;
                        err.code = code;
                        err.signal = sig;
                        errors.push(err);
                    }
                    if (pending === 0) cb(errors.length && errors);
                })
            });
        });
    };
    
    service.spawn = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var procs = {};
        drones.forEach(function (drone) {
            if (!opts.env) opts.env = {};
            if (!opts.env.DRONE_ID) opts.env.DRONE_ID = drone.id;
            
            drone.spawn(opts, function (pids) {
                procs[drone.id] = pids;
                if (--pending === 0) cb(null, procs);
            });
        });
    };
    
    service.stop = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb(null, [])
        var procs = {};
        if (!Array.isArray(opts.pid)) opts.pid = [ opts.pid ];
        
        drones.forEach(function (drone) {
            drone.stop(opts, function (pids) {
                procs[drone.id] = pids;
                if (--pending === 0) cb(null, procs);
            });
        });
    };
    
    service.register = function (role, obj) {
        if (role === 'drone') {
            conn.on('ready', onready);
            function onready () {
                obj.addr = conn.stream.remoteAddress;
                self.drones.push(obj);

                if (typeof obj.fetch !== 'function') return;
            
                fs.readdir(self.repodir, function (err, repos) {
                    if (err) console.error(err)
                    else repos.forEach(function (repo) {
                        obj.fetch(repo, logger(obj.id));
                    });
                });
            }
            if (conn.stream) onready();
            
            conn.on('end', function () {
                var ix = self.drones.indexOf(obj);
                if (ix >= 0) self.drones.splice(ix, 1);
            });
        }
    };
    
    self.middleware.forEach(function (m) {
        m(service, conn);
    });
    
    return service;
};

Propagit.prototype.drone = function (fn) {
    var self = this;
    
    mkdirp(self.deploydir);
    mkdirp(self.repodir);
    
    self.processes = {};
    
    function refs (repo) {
        return {
            origin : self.gitUri + '/' + repo,
            repodir : path.join(self.repodir, repo + '.git'),
        }
    }
    self.on('error', self.emit.bind(self, 'error'));
    
    var actions = {};
    
    actions.fetch = function (repo, cb) {
        var p = refs(repo);
        spawn('git', [ 'init', '--bare', p.repodir ])
            .on('exit', function (code, sig) {
                if (code) cb(code, sig)
                else spawn('git', [ 'fetch', p.origin ], { cwd : p.repodir })
                    .on('exit', cb)
                ;
            })
        ;
    };
    
    actions.deploy = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        var dir = path.join(self.deploydir, repo + '.' + commit);
        var p = refs(repo);
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        spawn('git', [ 'clone', p.repodir, dir ])
            .on('exit', function (code, sig) {
                if (code) cb(code, sig)
                else spawn('git', [ 'checkout', commit ], { cwd : dir })
                    .on('exit', function (code, sig) {
                        self.emit('deploy', {
                            drone : actions.id,
                            commit : commit,
                            repo : repo,
                            cwd : dir,
                        });
                        cb(code, sig)
                    })
                ;
            })
        ;
    };
    
    actions.stop = function (opts, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var ids = opts.pid;
        if (!Array.isArray(ids)) ids = [ ids ];
        if (ids[0] === '*' || opts.commit) ids = Object.keys(self.processes);
        var filter;
        if (opts.commit) {
            filter = function (proc) {
                return proc && proc.commit.indexOf(opts.commit) === 0;
            };
        }

        cb(ids.filter(stopProcess.bind(null, filter)));

        function stopProcess(filter, id) {
            var proc = self.processes[id];
            filter = filter || function(proc) {
                return !!proc;
            };
            if (filter(proc)) {
                self.emit('stop', { drone : actions.id, id : id });
                proc.status = 'stopped';
                proc.process.kill();
                delete self.processes[id];
                return true;
            }
            else {
                return false;
            }
        }
    };
    
    actions.restart = function (id, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var proc = self.processes[id];
        if (!proc) cb('no such process')
        else {
            if (proc.status === 'stopped') proc.respawn()
            else proc.process.kill()
        }
    };
    
    actions.ps = function (cb) {
        cb(Object.keys(self.processes).reduce(function (acc, id) {
            var proc = self.processes[id];
            acc[id] = {
                status : proc.status,
                repo : proc.repo,
                commit : proc.commit,
                command : proc.command,
            };
            return acc;
        }, {}));
    };
    
    actions.spawn = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;

        if (opts.count > 1) {
            var s = seq();
            var c = opts.count;
            opts.count = 1;
            for (var i = 0; i < c; i++) {
                s.par(function() {
                    actions.spawn(opts, this);
                });
            }

            s.seq(function() {}).flatten().filter().seq(function(ids) {
                cb(null, ids);
            });
            return;
        }

        if (opts.limit) {
            var running = 0;
            Object.keys(self.processes).forEach(function(id) {
                if (self.processes[id].commit === commit && self.processes[id].status !== 'error') {
                    running++;
                }
            });
            if (running >= opts.limit) {
                return cb(null, []);
            }
        }
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        var id = Math.round((Math.random() * 15728639) + 1048576).toString(16);
        process.env.PROCESS_ID = id;
        
        Object.keys(opts.env || {}).forEach(function (key) {
            process.env[key] = opts.env[key];
        });
        
        var dir = opts.cwd || path.join(self.deploydir, repo + '.' + commit);
        
        var cmd = opts.command[0];
        var args = opts.command.slice(1);
        var spawned = new Date();
        
        var processes = self.processes;
        (function respawn () {
            var ps = spawn(cmd, args, { cwd : dir });
            var proc = self.processes[id] = {
                status : 'running',
                repo : repo,
                commit : commit,
                command : opts.command,
                cwd : dir,
                process : ps,
                respawn : respawn,
                respawns : (self.processes[id] && self.processes[id].respawns) || 0,
                drone : actions.id,
            };
            
            ps.stdout.on('data', function (buf) {
                self.emit('stdout', buf, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                });
            });
            
            ps.stderr.on('data', function (buf) {
                self.emit('stderr', buf, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                });
            });
            
            ps.once('exit', function (code, sig) {
                self.emit('exit', code, sig, {
                    drone : actions.id,
                    id : id,
                    repo : repo,
                    commit : commit,
                    command : opts.command,
                });
                
                if (opts.once) {
                    delete self.processes[id];
                }
                else if (proc.status !== 'stopped') {
                    if (opts.errlimit) {
                        if (new Date().getTime() - spawned.getTime() <= 30000 && proc.respawns >= opts.errlimit) {
                            proc.status = 'error';
                            setTimeout(function() {
                                delete self.processes[id];
                            }, 10000);
                            return;
                        }
                    }
                    proc.status = 'respawning';
                    proc.respawns++;
                    setTimeout(function () {
                        if (proc.status !== 'stopped') respawn();
                    }, 1000);
                }
            });
            
            self.emit('spawn', {
                drone : actions.id,
                id : id,
                repo : repo,
                commit : commit,
                command : opts.command,
                cwd : dir,
            });
        })();
        
        cb(null, [id]);
    };
    
    actions.id = (Math.random() * Math.pow(16,8)).toString(16);
    if (typeof fn === 'function') fn.call(self, actions);
    
    self.middleware.forEach(function (m) {
        m(actions);
    });
    
    function onup (remote) {
        remote.register('drone', actions);
    }
    self.hub(onup);
    self.hub.on('down', function () {
        self.hub.once('up', onup);
    });
    
    return self;
};

Propagit.prototype.stop = function (opts, cb) {
    var self = this;
    
    self.hub(function (hub) {
        hub.stop(opts, function(err, procs) {
            self.emit('stop', procs);
            if (cb) cb(null, procs);
        });
    });

    return self;
};

Propagit.prototype.spawn = function (opts) {
    var self = this;
    
    self.hub(function (hub) {
        hub.spawn(opts, function () {
            self.emit('spawn');
        });
    });
    
    return self;
};

Propagit.prototype.deploy = function (opts, cb) {
    var self = this;
    
    self.hub(function (hub) {
        hub.deploy(opts, function () {
            self.emit('deploy');
            if (cb) cb();
        });
    });
    
    return self;
};

Propagit.prototype.ps = function () {
    var self = this;
    var stream = new Stream;
    self.hub(function (hub) {
        hub.ps(stream.emit.bind(stream));
    });
    return stream;
};
