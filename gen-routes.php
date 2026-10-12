<?php
// Builds route payloads for the seven walk clips with the app's own
// RouteViewerService, so the mockups render real component output.
// php gen-routes.php <app-root> <classified.json> <out.json>
[$_, $root, $classified, $out] = $argv;
chdir($root);
define('HOMEPATH', $root . '/');
define('CONFIGPATH', $root . '/app/Config/');
define('PUBLICPATH', $root . '/public/');
$_SERVER['CI_ENVIRONMENT'] = 'testing';
foreach (['app.baseURL' => 'http://example.com/', 'app.uriProtocol' => 'REQUEST_URI'] as $k => $v) { $_SERVER[$k] = $v; $_ENV[$k] = $v; putenv("$k=$v"); }
require $root . '/vendor/codeigniter4/framework/system/Test/bootstrap.php';

$clips = json_decode(file_get_contents($classified), true);
$walk = [
    [181, 'Hamstring stretch (hook-lying)', []],
    [2, 'Shoulder abduction with Theraband (standing)', ['sets' => 3, 'reps' => 10]],
    [555, 'Standing quad stretch with foot on a chair', []],
    [14, 'Tandem-stance balance', []],
    [98, 'Core work and stretches with the strap', []],
    [349, 'Neck isometrics (flexion)', []],
    [139, 'Forearm stretch, wrist flexed', []],
];
service('language')->setLocale('en');
$svc = new \App\Services\RouteViewerService();
$res = [];
foreach ($walk as [$i, $title, $dose]) {
    $steps = $clips[$i]['steps'];
    $route = $svc->build($steps, ['locale' => 'en', 'localeUsed' => 'en', 'dose' => $dose + ['sets' => null, 'reps' => null, 'hold_seconds' => null]]);
    $res[] = ['title' => $title, 'route' => $route, 'prose' => implode(' ', array_column($steps, 'text'))];
}
$i18n = require $root . '/app/Language/en/RouteViewer.php';
file_put_contents($out, json_encode(['clips' => $res, 'i18n' => $i18n], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
echo "ok\n";
