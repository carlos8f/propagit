var test = require('tap').test;

var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');

var mkdirp = require('mkdirp');
var http = require('http');

var cmd = __dirname + '/../bin/cli.js';
var tmpdir = '/tmp/' + Math.floor(Math.random() * (1<<24)).toString(16);
var dirs = {
    hub : tmpdir + '/hub',
    drone1 : tmpdir + '/drone1',
    drone2 : tmpdir + '/drone2',
    repo : tmpdir + '/webapp',
};
mkdirp.sync(dirs.hub);
mkdirp.sync(dirs.drone1);
mkdirp.sync(dirs.drone2);
mkdirp.sync(dirs.repo);

var src = fs.readFileSync(__dirname + '/webapp/server.js');
fs.writeFileSync(dirs.repo + '/server.js', src);

test('command line deploy', function (t) {
    var port = Math.floor(Math.random() * 5e4 + 1e4);
    var httpPort1 = Math.floor(Math.random() * 5e4 + 1e4);
    var httpPort2 = Math.floor(Math.random() * 5e4 + 1e4);
    
    var ps = {};
    ps.hub = spawn(
        cmd, [ 'hub', '--port=' + port, '--secret=beepboop' ],
        { cwd : dirs.hub }
    );
    ps.hub.stdout.pipe(process.stdout, { end : false });
    ps.hub.stderr.pipe(process.stderr, { end : false });
    
    ps.drone1 = spawn(
        cmd, [ 'drone', '--hub=localhost:' + port, '--secret=beepboop' ],
        { cwd : dirs.drone1 }
    );
    ps.drone1.stdout.pipe(process.stdout, { end : false });
    ps.drone1.stderr.pipe(process.stderr, { end : false });

    ps.drone2 = spawn(
        cmd, [ 'drone', '--hub=localhost:' + port, '--secret=beepboop' ],
        { cwd : dirs.drone2 }
    );
    ps.drone2.stdout.pipe(process.stdout, { end : false });
    ps.drone2.stderr.pipe(process.stderr, { end : false });
    
    setTimeout(function () {
        var opts = { cwd : dirs.repo };
        var commands = [
            'git init',
            'git add server.js',
            'git commit -m"web server"',
            'git log|head -n1',
            function (line) {
                var commit = line.split(/\s+/)[1]
                exec(
                    'git push http://localhost:'
                        + (port + 1)
                        + '/webapp master',
                    opts,
                    deploy.bind(null, commit)
                );
            }
        ];
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
    }, 2000);
    
    function deploy (commit, err, stdout, stderr) {
        if (err) t.fail(err);
        ps.deploy = spawn(cmd, [
            'deploy', '--hub=localhost:' + port, '--secret=beepboop',
            'webapp', commit
        ]);
        ps.deploy.on('exit', run.bind(null, commit));
    }
    
    function run (commit) {
        ps.run = spawn(cmd, [
            'spawn', '--hub=localhost:' + port, '--secret=beepboop',
            '--env.PROPAGIT_BEEPITY=boop',
            'webapp', commit,
            'node', 'server.js', httpPort1,
        ]);
        ps.run = spawn(cmd, [
            'spawn', '--hub=localhost:' + port, '--secret=beepboop',
            '--env.PROPAGIT_BEEPITY=boop',
            'webapp', commit,
            'node', 'server.js', httpPort2,
        ]);
        setTimeout(function() {
            var pids = [];
            testServer(httpPort1, function(droneId, processId) {
                pids.push(processId);
                assertProcess(droneId, processId, function() {
                    testServer(httpPort2, function(droneId, processId) {
                        pids.push(processId);
                        assertProcess(droneId, processId, function() {
                            setTimeout(stop.bind(null, pids), 1000);
                        });
                    })
                });
            });
        }, 2000);
    }
    
    function testServer (port, cb) {
        var opts = { host : 'localhost', port : port, path : '/' };
        http.get(opts, function (res) {
            var data = '';
            res.on('data', function (buf) { data += buf });
            res.on('end', function () {
                var obj = JSON.parse(data);
                t.equal(obj[0], 'beepity');
                t.equal(obj[1].REPO, 'webapp');
                t.ok(obj[1].COMMIT.match(/^[0-9a-f]{40}$/));
                t.equal(obj[1].PROPAGIT_BEEPITY, 'boop');
                var processId = obj[1].PROCESS_ID;
                t.ok(processId.match(/^[0-9a-f]{6,}$/));
                
                var droneId = obj[1].DRONE_ID;

                cb(droneId, processId);
            });
        });
    }
    
    function assertProcess (droneId, processId, cb) {
        var json = '';
        var p = spawn(cmd, [
            'ps', '--json',
            '--hub=localhost:' + port, '--secret=beepboop',
        ]);
        p.stdout.on('data', function (buf) { json += buf });
        p.stdout.on('end', function () {
            var obj = JSON.parse(json);
            t.ok(obj[droneId][processId]);
            cb();
        });
    }

    function stop (pids) {
        ps.stop = spawn(cmd, [
            'stop', '--hub=localhost:' + port, '--secret=beepboop',
            '--all',
        ]);
        ps.stop.stdout.pipe(process.stdout, { end : false });
        ps.stop.stderr.pipe(process.stderr, { end : false });
        ps.stop.on('exit', function() {
            setTimeout(assertAllStopped, 1000);
        });
    }

    function assertAllStopped () {
        ps.ps2 = spawn(cmd, [
            'ps', '--json',
            '--hub=localhost:' + port, '--secret=beepboop',
        ]);
        var json = '';
        ps.ps2.stdout.on('data', function (buf) { json += buf });
        ps.ps2.stdout.on('end', function () {
            var obj = JSON.parse(json);
            Object.keys(obj).forEach(function(droneId) {
                t.equal(Object.keys(obj[droneId]).length, 0);
            });
            t.end();
        });
    }
    
    t.on('end', function () {
        Object.keys(ps).forEach(function (name) {
            ps[name].kill();
        });
    });
});
