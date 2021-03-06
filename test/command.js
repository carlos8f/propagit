var test = require('tap').test;

var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');
var seq = require('seq');

var mkdirp = require('mkdirp');
var http = require('http');

var cmd = __dirname + '/../bin/cli.js';
var tmpdir = '/tmp/' + Math.floor(Math.random() * (1<<24)).toString(16);
var dirs = {
    hub : tmpdir + '/hub',
    repo : tmpdir + '/webapp',
};
Object.keys(dirs).forEach(function(name) {
    mkdirp.sync(dirs[name]);
});
var drones = [];
var initialDrones = 3;
var deployCount = 2;

var src = fs.readFileSync(__dirname + '/webapp/server.js');
fs.writeFileSync(dirs.repo + '/server.js', src);

test('command line deploy', function (t) {
    var port = Math.floor(Math.random() * 5e4 + 1e4);
    var gitURI = 'http://localhost:' + (port + 1) + '/webapp';
    
    var ps = {};
    ps.hub = spawn(
        cmd, [ 'hub', '--port=' + port, '--secret=beepboop' ],
        { cwd : dirs.hub }
    );
    ps.hub.stdout.pipe(process.stdout, { end : false });
    ps.hub.stderr.pipe(process.stderr, { end : false });

    httpPorts = [], commits = [];
    
    for (var i = 0; i < initialDrones; i++) {
        makeDrone();
    }

    function makeDrone () {
        var name = randomHash();
        drones.push(name);
        dirs[name] = tmpdir + '/' + name;
        mkdirp.sync(dirs[name]);
        ps[name] = spawn(
            cmd, [ 'drone', '--hub=localhost:' + port, '--secret=beepboop' ],
            { cwd : dirs[name] }
        );
        ps[name].stdout.on('data', function (buf) {
            var matches = /port:(\d+)/.exec(buf);
            if (matches) {
                httpPorts.push(parseInt(matches[1]));
            }
        });
        ps[name].stdout.pipe(process.stdout, { end : false });
        ps[name].stderr.pipe(process.stderr, { end : false });
    }

    function doCommands (commands) {
        var opts = { cwd : dirs.repo };
        (function pop (s) {
            var cmd = commands.shift();
            if (!cmd) return;
            else if (typeof cmd === 'string') {
                exec(cmd, opts, function (err, out) {
                    pop(out);
                });
            }
            else if (typeof cmd === 'function') {
                cmd(s);
            }
        })();
    }

    (function initialCommit () {
        setTimeout(doCommands.bind(null, [
            'git init',
            'git add server.js',
            'git commit -m"web server"',
            'git log|head -n1',
            function (line) {
                commits.push(line.split(/\s+/)[1]);
                exec(
                    'git push ' + gitURI + ' master',
                    { cwd : dirs.repo },
                    deploy.bind(null, commits[0], testInitialVersion)
                );
            }
        ]), 2000);
    })();

    function testInitialVersion () {
        var s = seq(), expected = 'beepity';
        t.equal(httpPorts.length, drones.length * deployCount);
        httpPorts.forEach(function (port) {
            s.par(function () {
                testServer(port, expected, this);
            });
        });
        s.seq(secondCommit);
    }

    function secondCommit () {
        httpPorts = [];
        doCommands([
            'sed -i s/beep/boop/g server.js',
            'git commit -a -m "boopify"',
            'git log|head -n1',
            function (line) {
                commits.push(line.split(/\s+/)[1]);
                exec(
                    'git push ' + gitURI + ' master',
                    { cwd : dirs.repo },
                    deploy.bind(null, commits[1], testSecondVersion.bind(null, testSpawnError))
                );
            }
        ]);
    }

    function testSecondVersion (cb) {
        var s = seq(), expected = 'boopity';
        t.equal(httpPorts.length, drones.length * deployCount);
        httpPorts.forEach(function (port) {
            s.par(function () {
                testServer(port, expected, this);
            });
        });
        s.seq(cb);
    }

    function testSpawnError () {
        var run = randomHash();
        ps[run] = spawn(cmd, [
            'spawn', '--hub=localhost:' + port, '--secret=beepboop',
            '--drone=*', '--count=' + deployCount, '--errlimit=1',
            '--env.PROPAGIT_BEEPITY=boop',
            'webapp', commits[1],
            'node', 'nonexistent.js',
        ]);
        setTimeout(function() {
            getProcs(function(procs) {
                errorCount = 0;
                Object.keys(procs).forEach(function(droneId) {
                    Object.keys(procs[droneId]).forEach(function(processId) {
                        if (procs[droneId][processId].status === 'error') {
                            errorCount++;
                        }
                    });
                });
                t.equal(errorCount, drones.length * deployCount);
                testSpawnBeforeDeploy();
            });
        }, 3000);
    }

    function testSpawnBeforeDeploy () {
        var newDroneCount = 2;
        makeMoreDrones(newDroneCount, function() {
            var run = randomHash();
            ps[run] = spawn(cmd, [
                'spawn', '--hub=localhost:' + port, '--secret=beepboop',
                '--drone=*', '--limit=' + deployCount, '--count=' + deployCount, '--errlimit=1',
                '--env.PROPAGIT_BEEPITY=boop',
                'webapp', commits[1],
                'node', 'server.js',
            ]);
            setTimeout(function() {
                getProcs(function(procs) {
                    errorCount = 0;
                    Object.keys(procs).forEach(function(droneId) {
                        Object.keys(procs[droneId]).forEach(function(processId) {
                            if (procs[droneId][processId].status === 'error' && procs[droneId][processId].command[1] === 'server.js') {
                                errorCount++;
                            }
                        });
                    });
                    t.equal(errorCount, 0);
                    deploy(commits[1], testSecondVersion.bind(null, testHosts));
                });
            }, 1000);
        });
    }

    function makeMoreDrones (newDroneCount, cb) {
        for (var i = 0; i < newDroneCount; i++) {
            makeDrone();
        }
        setTimeout(cb, 1000);
    }

    function testHosts () {
        var json = '';
        var p = randomHash();
        ps[p] = spawn(cmd, [
            'hosts', '--json', '--hub=localhost:' + port, '--secret=beepboop',
        ]);
        ps[p].stdout.on('data', function (buf) { json += buf });
        ps[p].stdout.on('end', function () {
            var obj = JSON.parse(json);
            var keys = Object.keys(obj);
            t.equal(keys.length, 1);
            t.equal(obj[keys[0]].length, drones.length);
            stopFirstCommit();
        });
    }

    function stopFirstCommit () {
        stop(['--commit', commits[0].substr(0, 8)], function() {
            setTimeout(function() {
                getProcs(function(procs) {
                    var droneCount = 0;
                    Object.keys(procs).forEach(function (droneId) {
                        droneCount++;
                        var runningCount = 0;
                        Object.keys(procs[droneId]).forEach(function(processId) {
                            if (procs[droneId][processId].status === 'running') {
                                runningCount++;
                            }
                            t.equal(procs[droneId][processId].commit, commits[1]);
                        });
                        t.equal(runningCount, deployCount);
                    });
                    t.equal(droneCount, drones.length);
                    stopAll();
                });
            }, 2000);
        });
    }

    function stopAll () {
        stop(['--all'], function() {
            setTimeout(function() {
                getProcs(function(procs) {
                    var droneCount = 0;
                    Object.keys(procs).forEach(function (droneId) {
                        droneCount++;
                        var keys = Object.keys(procs[droneId]);
                        t.equal(keys.length, 0);
                    });
                    t.equal(droneCount, drones.length);
                    t.end();
                });
            }, 2000);
        });
    }
    
    function deploy (commit, cb, err, stdout, stderr) {
        if (err) t.fail(err);
        var deploy = randomHash();
        ps[deploy] = spawn(cmd, [
            'deploy', '--hub=localhost:' + port, '--secret=beepboop',
            'webapp', commit
        ]);
        ps[deploy].on('exit', run.bind(null, commit, cb));
    }
    
    function run (commit, cb) {
        var run = randomHash();
        ps[run] = spawn(cmd, [
            'spawn', '--hub=localhost:' + port, '--secret=beepboop',
            '--drone=*', '--count=' + deployCount, '--limit=' + deployCount,
            '--env.PROPAGIT_BEEPITY=boop',
            'webapp', commit,
            'node', 'server.js',
        ]);

        setTimeout(assertRunning.bind(null, commit, cb), 2000);
    }

    function randomHash () {
        return Math.floor(Math.random() * (1<<24)).toString(16);
    }

    function getProcs (cb) {
        var json = '';
        var p = randomHash();
        ps[p] = spawn(cmd, [
            'ps', '--json',
            '--hub=localhost:' + port, '--secret=beepboop',
        ]);
        ps[p].stdout.on('data', function (buf) { json += buf });
        ps[p].stdout.on('end', function () {
            cb(JSON.parse(json));
        });
    }

    function assertRunning (commit, cb) {
        getProcs(function (procs) {
            var running = 0;
            Object.keys(procs).forEach(function (droneId) {
                Object.keys(procs[droneId]).forEach(function (procId) {
                    if (procs[droneId][procId].commit === commit && procs[droneId][procId].status === 'running') {
                        running++;
                    }
                });
            });
            t.equal(running, drones.length * deployCount);
            cb();
        });
    }
    
    function testServer (port, expected, cb) {
        var opts = { host : 'localhost', port : port, path : '/' };
        http.get(opts, function (res) {
            var data = '';
            res.on('data', function (buf) { data += buf });
            res.on('end', function () {
                var obj = JSON.parse(data);
                t.equal(obj[0], expected);
                t.equal(obj[1].REPO, 'webapp');
                t.ok(obj[1].COMMIT.match(/^[0-9a-f]{40}$/));
                t.equal(obj[1].PROPAGIT_BEEPITY, 'boop');
                t.ok(obj[1].PROCESS_ID.match(/^[0-9a-f]{6,}$/));
                cb();
            });
        });
    }

    function stop (args, cb) {
        var stop = randomHash();
        ps[stop] = spawn(cmd, [
            'stop', '--hub=localhost:' + port, '--secret=beepboop',
        ].concat(args));
        ps[stop].on('exit', cb);
    }
    
    t.on('end', function () {
        Object.keys(ps).forEach(function (name) {
            ps[name].kill();
        });
    });
});
