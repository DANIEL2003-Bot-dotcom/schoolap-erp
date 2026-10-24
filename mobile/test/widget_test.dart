import 'package:ecole_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// sqflite (FFI) et le faux client HTTP terminent leurs futures hors du temps simulé :
/// on alterne temps réel (runAsync) et pompage du framework.
Future<void> settle(WidgetTester tester, {int rounds = 12}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<AppController> buildController(WidgetTester tester, FakeConnectivity net, FakeServer server) async {
  late AppController c;
  await tester.runAsync(() async {
    final db = await openTestDb();
    await db.applyBootstrap(bootstrapJson());
    await db.setKv('api_url', 'http://api.test');
    await db.setKv('token', 'jeton');
    await db.setKv('user_name', 'Kambale Jean');
    await db.setKv('school_name', 'Institut Mwanga');
    c = AppController(db: db, connectivity: net, httpClient: server.client);
    await c.init();
  });
  return c;
}

void main() {
  testWidgets('appel : nuage orange hors ligne, coche verte après synchronisation', (tester) async {
    final net = FakeConnectivity(online: false);
    final server = FakeServer();
    final c = await buildController(tester, net, server);
    await tester.pumpWidget(EcoleApp(controller: c));
    await settle(tester);

    expect(find.text('KAHINDO MASIKA Grâce'), findsOneWidget);
    expect(find.byKey(const ValueKey('sync-none')), findsNWidgets(3));
    expect(find.text('Hors ligne'), findsOneWidget);

    // Interrupteur → absent : stocké dans sqflite, nuage orange
    await tester.tap(find.byKey(ValueKey('switch-${studentIds[0]}')));
    await settle(tester);
    expect(find.byKey(const ValueKey('sync-local')), findsOneWidget);
    expect(find.text('Absent · MWG-001', findRichText: true), findsOneWidget);
    expect(server.requests, isEmpty);

    // Les deux autres présents d'un coup
    await tester.tap(find.byKey(const Key('mark-all-present')));
    await settle(tester);
    expect(find.byKey(const ValueKey('sync-local')), findsNWidgets(3));
    expect(find.text('3'), findsOneWidget); // compteur de la file dans la barre

    // Retour du réseau : la file est rejouée, coches vertes
    net.set(true);
    await settle(tester, rounds: 20);
    expect(server.requests.where((r) => r.url.path == '/api/attendance/sync'), isNotEmpty);
    expect(find.byKey(const ValueKey('sync-synced')), findsNWidgets(3));
    expect(find.textContaining('SMS envoyé', findRichText: true), findsOneWidget);
    expect(find.text('À jour'), findsOneWidget);

    c.sync.dispose();
    await tester.runAsync(() => c.db.close());
  });

  testWidgets('cotes : saisie rapide, validation et passage à l’élève suivant', (tester) async {
    final net = FakeConnectivity(online: false);
    final server = FakeServer();
    final c = await buildController(tester, net, server);
    await tester.pumpWidget(EcoleApp(controller: c));
    await settle(tester);

    await tester.tap(find.text('Cotes'));
    await settle(tester);

    await tester.enterText(find.byKey(ValueKey('score-${studentIds[0]}')), '25');
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await settle(tester);
    expect(find.text('0 à 20'), findsOneWidget);

    await tester.enterText(find.byKey(ValueKey('score-${studentIds[0]}')), '14,5');
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await settle(tester);
    expect(find.text('0 à 20'), findsNothing);
    final second = tester.widget<TextField>(find.byKey(ValueKey('score-${studentIds[1]}')));
    expect(second.focusNode!.hasFocus, isTrue, reason: 'le curseur passe à l’élève suivant');

    final grades = await tester.runAsync(
        () => c.db.gradesFor(classId: classId, subjectId: subjectId, term: 'T1', evaluation: 'Interrogation 1'));
    expect(grades![studentIds[0]]!.score, 14.5);
    expect(find.byKey(const ValueKey('sync-local')), findsOneWidget);

    c.sync.dispose();
    await tester.runAsync(() => c.db.close());
  });
}
