"""Tests for scripts/serve.py: what the local server exposes, especially with --lan.

    python3 -m unittest tests.test_serve -v

With --lan the server listens on every interface, so its path allowlist is all that keeps
.git/, scripts/ and the rest of the repo away from anything on the same Wi-Fi.
"""
import functools
import http.client
import http.server
import os
import sys
import threading
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import serve  # noqa: E402


class ServedFilesTests(unittest.TestCase):
    """A real server on a free local port, serving the repo the way serve.py does."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(serve.Handler, directory=ROOT))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def status(self, path):
        """The status for this exact request path (http.client sends it unchanged, '..' included)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", path)
            return conn.getresponse().status
        finally:
            conn.close()

    def test_should_serve_the_app(self):
        self.assertEqual(self.status("/index.html"), 200)

    def test_should_serve_the_app_assets(self):
        self.assertEqual(self.status("/assets/js/app.js"), 200)

    def test_should_serve_the_guide_for_ai_assistants(self):
        self.assertEqual(self.status("/llms.txt"), 200)

    def test_should_refuse_the_git_folder(self):
        self.assertEqual(self.status("/.git/config"), 404)

    def test_should_refuse_the_scripts(self):
        self.assertEqual(self.status("/scripts/sync.py"), 404)

    def test_should_refuse_a_path_that_climbs_out_of_an_allowed_folder(self):
        self.assertEqual(self.status("/assets/../scripts/sync.py"), 404)

    def test_should_refuse_an_encoded_climb_out_of_an_allowed_folder(self):
        self.assertEqual(self.status("/assets/%2e%2e/scripts/sync.py"), 404)


def post(path="/api/sync", origin=None, host="192.168.1.20:8026", client="192.168.1.30", token="lan-secret"):
    """Calls serve.Handler.do_POST on a request built by hand (the client address of a real
    socket in a test is always loopback); -> (status, body). The sync itself is faked."""
    h = serve.Handler.__new__(serve.Handler)
    h.path = path
    h.headers = {"Host": host, **({"Origin": origin} if origin else {})}
    h.client_address = (client, 50000)
    h.token = token
    sent = {}
    h._json = lambda code, obj: sent.update(code=code, obj=obj)
    fake = types.SimpleNamespace(returncode=0, stdout="synced", stderr="")
    with mock.patch.object(serve, "run_sync", return_value=fake):
        h.do_POST()
    return sent["code"], sent["obj"]


class SyncEndpointTests(unittest.TestCase):
    """POST /api/sync runs scripts/sync.py on the computer running serve.py."""

    def test_should_run_a_sync_for_the_computer_itself(self):
        self.assertEqual(post(client="127.0.0.1", host="localhost:8026")[0], 200)

    def test_should_run_a_sync_for_a_phone_with_the_lan_token(self):
        self.assertEqual(post(path="/api/sync?token=lan-secret")[0], 200)

    def test_should_refuse_a_sync_from_a_phone_without_the_lan_token(self):
        self.assertEqual(post()[0], 403)

    def test_should_refuse_a_sync_from_a_phone_with_a_wrong_token(self):
        self.assertEqual(post(path="/api/sync?token=guess")[0], 403)

    def test_should_refuse_a_sync_requested_by_another_site(self):
        self.assertEqual(post(client="127.0.0.1", host="localhost:8026", origin="https://evil.example")[0], 403)

    def test_should_refuse_a_second_sync_while_one_is_running(self):
        with serve._lock:
            self.assertEqual(post(client="127.0.0.1", host="localhost:8026")[0], 409)


if __name__ == "__main__":
    unittest.main()
