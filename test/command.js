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
var drones = ['drone1', 'drone2', 'drone3'];
drones.forEach(function (drone) {
    dirs[drone] = tmpdir + '/' + drone;
});
Object.keys(dirs).forEach(function (name) {
    mkdirp.sync(dirs[name]);
});

var src = fs.readFileSync(__dirname + '/webapp/server.js');
fs.writeFileSync(dirs.repo + '/server.js', src);

test('command line deploy', function (t) {
    var port = Math.floor(Math.random() * 5e4 + 1e4);
    
    var ps = {};
    ps.hub = spawn(
        cmd, [ 'hub', '--port=' + port, '--secret=beepboop' ],
        { cwd : dirs.hub }
    );
    ps.hub.stdout.pipe(process.stdout, { end : false });
    ps.hub.stderr.pipe(process.stderr, { end : false });

    httpPorts = [], commits = [];
    
    drones.forEach(function (drone) {
        ps[drone] = spawn(
            cmd, [ 'drone', '--hub=localhost:' + port, '--secret=beepboop' ],
            { cwd : dirs[drone] }
        );
        ps[drone].stdout.on('data', function (buf) {
            var matches = /port:(\d+)/.exec(buf);
            if (matches) {
                httpPorts.push(parseInt(matches[1]));
            }
        });
        ps[drone].stdout.pipe(process.stdout, { end : false });
        ps[drone].stderr.pipe(process.stderr, { end : false });
    });

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
                    'git push http://localhost:'
                        + (port + 1)
                        + '/webapp master',
                    { cwd : dirs.repo },
                    deploy.bind(null, commits[0], testInitialVersion)
                );
            }
        ]), 2000);
    })();

    function testInitialVersion () {
        var s = seq(), expected = 'beepity';
        t.equal(httpPorts.length, drones.length);
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
                    'git push http://localhost:'
                        + (port + 1)
                        + '/webapp master',
                    { cwd : dirs.repo },
                    deploy.bind(null, commits[1], testSecondVersion)
                );
            }
        ]);
    }

    function testSecondVersion () {
        var s = seq(), expected = 'boopity';
        t.equal(httpPorts.length, drones.length);
        httpPorts.forEach(function (port) {
            s.par(function () {
                testServer(port, expected, this);
            });
        });
        s.seq(stopFirstCommit.bind(null));
    }

    function stopFirstCommit () {
        stop(['--commit', commits[0].substr(0, 8)], function() {
            setTimeout(function() {
                getProcs(function(procs) {
                    Object.keys(procs).forEach(function (droneId) {
                        var keys = Object.keys(procs[droneId]);
                        t.equal(keys.length, 1);
                        keys.forEach(function(processId) {
                            t.equal(procs[droneId][processId].commit, commits[1]);
                        });
                    });
                    stopAll();
                });
            }, 2000);
        });
    }

    function stopAll () {
        stop(['--all'], function() {
            setTimeout(function() {
                getProcs(function(procs) {
                    Object.keys(procs).forEach(function (droneId) {
                        var keys = Object.keys(procs[droneId]);
                        t.equal(keys.length, 0);
                    });
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
            '--drone=*', '--env.PROPAGIT_BEEPITY=boop',
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
            t.equal(running, drones.length);
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
