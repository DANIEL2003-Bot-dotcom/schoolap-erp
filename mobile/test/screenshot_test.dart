// Captures d'écran avec les vraies polices Roboto / Material Icons :
//   flutter test test/screenshot_test.dart --update-goldens
@Tags(['screenshots'])
library;

import 'dart:io';

import 'package:ecole_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';
import 'widget_test.dart' show settle;

Future<void> _loadFonts() async {
  final dir = '${Platform.environment['FLUTTER_ROOT']}/bin/cache/artifacts/material_fonts';
  Future<ByteData> read(String f) async => ByteData.sublistView(await File('$dir/$f').readAsBytes());
  final roboto = FontLoader('Roboto')
    ..addFont(read('Roboto-Regular.ttf'))
    ..addFont(read('Roboto-Medium.ttf'))
    ..addFont(read('Roboto-Bold.ttf'));
  final icons = FontLoader('MaterialIcons')..addFont(read('MaterialIcons-Regular.otf'));
  await Future.wait([roboto.load(), icons.load()]);
}

const _names = [
  ['Bahati', 'Kasongo', 'Héritier'],
  ['Kahindo', 'Masika', 'Grâce'],
  ['Kambale', 'Paluku', 'Josué'],
  ['Kasereka', 'Matumo', 'Daniel'],
  ['Kavugho', 'Nzanzu', 'Sarah'],
  ['Mbusa', 'Kombi', 'Gloire'],
  ['Muhindo', 'Mwenge', 'Naomie'],
  ['Mumbere', 'Siwako', 'Moïse'],
  ['Vahwere', 'Kitsa', 'Divine'],
];

String _sid(int i) => 'cccccccc-0000-4000-8000-${i.toString().padLeft(12, '0')}';

void main() {
  setUpAll(_loadFonts);

  testWidgets('captures appel et cotes', (tester) async {
    tester.view.devicePixelRatio = 2.0;
    tester.view.physicalSize = const Size(390, 780) * 2.0;
    addTearDown(tester.view.reset);

    final net = FakeConnectivity(online: false);
    final server = FakeServer();
    final today = isoDate(DateTime.now());
    late AppController c;
    await tester.runAsync(() async {
      final db = await openTestDb();
      final data = bootstrapJson(
        attendance: [
          for (final i in [0, 1, 2, 3])
            {
              'id': 'dddddddd-0000-4000-8000-00000000000$i',
              'studentId': _sid(i),
              'classId': classId,
              'date': today,
              'status': i == 2 ? 'ABSENT' : 'PRESENT',
              'clientUpdatedAt': DateTime.now().toUtc().toIso8601String(),
            },
        ],
      );
      (data['classes'] as List).first['students'] = [
        for (var i = 0; i < _names.length; i++)
          {'id': _sid(i), 'matricule': 'MWG-2026-P5-${(i + 1).toString().padLeft(3, '0')}', 'lastName': _names[i][0], 'middleName': _names[i][1], 'firstName': _names[i][2]},
      ];
      await db.applyBootstrap(data);
      await db.setKv('api_url', 'http://api.test');
      await db.setKv('token', 'jeton');
      await db.setKv('user_name', 'Kambale Jean');
      await db.setKv('school_name', 'Institut Mwanga — Goma');
      c = AppController(db: db, connectivity: net, httpClient: server.client);
      await c.init();
    });

    await tester.pumpWidget(EcoleApp(controller: c));
    await settle(tester);
    // Hors ligne : 3 élèves pointés localement (nuage orange), 1 absent
    await tester.tap(find.byKey(ValueKey('switch-${_sid(4)}')));
    await settle(tester, rounds: 4);
    await tester.tap(find.byKey(ValueKey('student-${_sid(5)}')));
    await settle(tester, rounds: 4);
    await tester.tap(find.byKey(ValueKey('switch-${_sid(1)}')));
    await settle(tester, rounds: 4);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('captures/appel_hors_ligne.png'));

    await tester.tap(find.text('Cotes'));
    await settle(tester);
    final scores = ['14', '16,5', '9', '12'];
    for (var i = 0; i < scores.length; i++) {
      await tester.enterText(find.byKey(ValueKey('score-${_sid(i)}')), scores[i]);
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await settle(tester, rounds: 3);
    }
    net.set(true);
    await settle(tester, rounds: 20);
    await tester.enterText(find.byKey(ValueKey('score-${_sid(4)}')), '11');
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await settle(tester, rounds: 3);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('captures/cotes_saisie_rapide.png'));

    c.sync.dispose();
    await tester.runAsync(() => c.db.close());
  });
}
