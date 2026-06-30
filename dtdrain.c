/*
 * dtdrain — lossy drain relay (Claude Code Helper)
 *
 * Sits between `dtach -a` and a code-server terminal pty:
 *     dtach -a <sock> -E -z -r winch | dtdrain
 *
 * Problem it solves: code-server's pty host pauses the pty after 100 000
 * unacknowledged bytes (VS Code terminal flow control, ptyHostMain.js). On a
 * half-open / silently dropped websocket the browser stops acking, the pty
 * pauses, the full pty blocks `dtach -a`'s stdout write, which blocks the dtach
 * master in select() (master.c), which blocks Claude's stdout write, which
 * trips Claude's ~120 s stall watchdog ("Response stalled mid-stream").
 *
 * dtdrain copies stdin -> stdout but NEVER blocks on stdout: stdout is set
 * non-blocking and output is buffered in a bounded ring; when the terminal is
 * paused the ring fills and the oldest bytes are dropped. Thus `dtach -a` is
 * always drained, the master never blocks, and Claude keeps running in the
 * background through a disconnect. On reconnect the helper's focus-driven
 * SIGWINCH repaint restores the frame, so the dropped bytes don't matter.
 *
 * Input direction is untouched: keystrokes go terminal -> `dtach -a` stdin,
 * which is where dtach does all its tty work (raw mode, winsize), so the relay
 * on the output side cannot disturb it.
 */
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <errno.h>
#include <string.h>
#include <signal.h>

#define RING (256 * 1024)

int main(void) {
	int in = STDIN_FILENO, out = STDOUT_FILENO;
	signal(SIGPIPE, SIG_IGN);
	int fl = fcntl(out, F_GETFL);
	if (fl != -1) fcntl(out, F_SETFL, fl | O_NONBLOCK);

	static unsigned char ring[RING];
	size_t head = 0;   /* next write position; valid data is the last `count` bytes */
	size_t count = 0;  /* bytes pending in the ring */
	int in_open = 1;

	while (in_open || count > 0) {
		struct pollfd p[2];
		int n = 0, iIn = -1, iOut = -1;
		if (count > 0)  { p[n].fd = out; p[n].events = POLLOUT; iOut = n; n++; }
		/* Always poll input while open — even when the ring is full — so a paused
		 * terminal can never back-pressure the master; on overflow we drop oldest. */
		if (in_open)    { p[n].fd = in;  p[n].events = POLLIN;  iIn = n; n++; }
		if (n == 0) break;
		if (poll(p, n, -1) < 0) { if (errno == EINTR) continue; break; }

		if (iOut >= 0 && (p[iOut].revents & POLLOUT) && count > 0) {
			size_t tail = (head + RING - count) % RING;
			size_t span = (tail + count <= RING) ? count : (RING - tail);
			ssize_t w = write(out, ring + tail, span);
			if (w > 0) count -= (size_t)w;
			else if (w < 0 && errno != EAGAIN && errno != EINTR) count = 0; /* pty gone */
		}
		if (iIn >= 0 && (p[iIn].revents & (POLLIN | POLLHUP | POLLERR))) {
			unsigned char rb[65536];
			ssize_t r = read(in, rb, sizeof rb);
			if (r > 0) {
				for (ssize_t off = 0; off < r; ) {
					size_t chunk = (size_t)(r - off);
					size_t toEnd = RING - head;
					if (chunk > toEnd) chunk = toEnd;
					memcpy(ring + head, rb + off, chunk);
					head = (head + chunk) % RING;
					off += (ssize_t)chunk;
				}
				count += (size_t)r;
				if (count > RING) count = RING; /* oldest bytes overwritten/dropped */
			} else if (r == 0) in_open = 0;
			else if (errno != EAGAIN && errno != EINTR) in_open = 0;
		}
	}
	return 0;
}
