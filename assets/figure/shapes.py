"""Signed distance shapes and a surface mesher, for modelling the figure in code.

The body, the coat and the hair are written as signed distance fields: rounded
cones, ellipsoids and boxes joined with smooth unions, so muscles, joints and
folds blend the way a sculpted surface does. `mesh_field` samples a field on a
regular grid and turns its zero surface into a quad mesh with surface nets;
Blender's decimation then brings it down to a game budget.

A shape is evaluated two ways: `grid(x, y, z)` on an axis-aligned block of the
grid, given as three 1-D coordinate arrays, and `at(points)` at scattered
points. A composite evaluates each child only where the child's bounds reach,
so a small shape such as a nostril costs only its own neighbourhood. Distances
further than `MARGIN` from every shape are not exact, which is all the mesher
and the region tests need.

Pure numpy, with no Blender import, so it runs in Blender's Python or outside it.
"""

import numpy as np

MARGIN = 0.03  # m: a shape's bounds reach this far beyond it, more than any blend radius
FAR = np.float32(1.0)  # the distance written where no shape reaches


def _vec(v):
    return np.asarray(v, dtype=np.float64)


def frame(axis, forward=(0.0, -1.0, 0.0)):
    """A rotation whose rows are local x, y, z: z along `axis`, y towards `forward`."""
    z = _vec(axis)
    z = z / np.linalg.norm(z)
    y = _vec(forward) - z * np.dot(_vec(forward), z)
    if np.linalg.norm(y) < 1e-6:
        y = np.cross(z, (1.0, 0.0, 0.0))
    y = y / np.linalg.norm(y)
    x = np.cross(y, z)
    return np.stack([x, y, z])


def rotation(rx=0.0, ry=0.0, rz=0.0):
    """Rows of the local axes after rotating by rx, ry, rz radians (applied x, then y, then z)."""
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return (mz @ my @ mx).T


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def _grid_axes(x, y, z):
    return x[:, None, None], y[None, :, None], z[None, None, :]


def _in_bounds(points, bounds):
    lo, hi = bounds
    return np.all((points >= lo) & (points <= hi), axis=1)


class Shape:
    """A leaf shape: subclasses define `field(X, Y, Z)` on broadcast coordinates."""

    lo = None
    hi = None

    def bounds(self):
        return self.lo - MARGIN, self.hi + MARGIN

    def grid(self, x, y, z):
        return self.field(*_grid_axes(x, y, z))

    def at(self, points):
        points = np.asarray(points, dtype=np.float64)
        return self.field(points[:, 0], points[:, 1], points[:, 2])


def _local(X, Y, Z, centre, axes):
    """Coordinates in a shape's frame (rows of `axes` are its local axes in world)."""
    dx, dy, dz = X - centre[0], Y - centre[1], Z - centre[2]
    if axes is None:
        return dx, dy, dz
    return (axes[0, 0] * dx + axes[0, 1] * dy + axes[0, 2] * dz,
            axes[1, 0] * dx + axes[1, 1] * dy + axes[1, 2] * dz,
            axes[2, 0] * dx + axes[2, 1] * dy + axes[2, 2] * dz)


def _box_bounds(centre, axes, half):
    """World bounds of a box of half-extents `half` in frame `axes` around `centre`."""
    extent = np.abs(axes.T) @ _vec(half) if axes is not None else _vec(half)
    return centre - extent, centre + extent


class Cone(Shape):
    """A rounded cone from `a` (radius ra) to `b` (radius rb); a capsule when they match."""

    def __init__(self, a, b, ra, rb=None):
        self.a, self.b = _vec(a), _vec(b)
        self.ra, self.rb = float(ra), float(ra if rb is None else rb)
        r = max(self.ra, self.rb)
        self.lo = np.minimum(self.a, self.b) - r
        self.hi = np.maximum(self.a, self.b) + r

    def field(self, X, Y, Z):
        px, py, pz = _local(X, Y, Z, self.a, None)
        ba = self.b - self.a
        l2 = float(np.dot(ba, ba))
        rr = self.ra - self.rb
        a2 = l2 - rr * rr
        il2 = 1.0 / l2
        yy = px * ba[0] + py * ba[1] + pz * ba[2]
        zz = yy - l2
        qx, qy, qz = px * l2 - ba[0] * yy, py * l2 - ba[1] * yy, pz * l2 - ba[2] * yy
        x2 = qx * qx + qy * qy + qz * qz
        y2 = yy * yy * l2
        z2 = zz * zz * l2
        k = np.sign(rr) * rr * rr * x2
        end_b = np.sqrt(x2 + z2) * il2 - self.rb
        end_a = np.sqrt(x2 + y2) * il2 - self.ra
        side = (np.sqrt(np.maximum(x2 * a2 * il2, 0.0)) + yy * rr) * il2 - self.ra
        return np.where(np.sign(zz) * a2 * z2 > k, end_b, np.where(np.sign(yy) * a2 * y2 < k, end_a, side))


class Ellipsoid(Shape):
    """An ellipsoid of semi-axes `radii` around `centre`, in frame `axes` (rows: local x, y, z)."""

    def __init__(self, centre, radii, axes=None):
        self.c = _vec(centre)
        self.r = _vec(radii)
        self.axes = None if axes is None else _vec(axes)
        self.lo, self.hi = _box_bounds(self.c, self.axes, self.r)

    def field(self, X, Y, Z):
        lx, ly, lz = _local(X, Y, Z, self.c, self.axes)
        r = self.r
        k0 = np.sqrt((lx / r[0]) ** 2 + (ly / r[1]) ** 2 + (lz / r[2]) ** 2)
        k1 = np.sqrt((lx / r[0] ** 2) ** 2 + (ly / r[1] ** 2) ** 2 + (lz / r[2] ** 2) ** 2)
        # At the very centre the estimate is 0/0; the centre lies a minor radius deep.
        return np.where(k1 > 1e-6, k0 * (k0 - 1.0) / np.maximum(k1, 1e-6), -self.r.min())


class Box(Shape):
    """A box of half-extents `half` around `centre` in frame `axes`, its edges rounded by `round`."""

    def __init__(self, centre, half, axes=None, round=0.0):
        self.c = _vec(centre)
        self.half = _vec(half)
        self.round = float(round)
        self.axes = None if axes is None else _vec(axes)
        self.lo, self.hi = _box_bounds(self.c, self.axes, self.half)

    def field(self, X, Y, Z):
        lx, ly, lz = _local(X, Y, Z, self.c, self.axes)
        inner = self.half - self.round
        qx, qy, qz = np.abs(lx) - inner[0], np.abs(ly) - inner[1], np.abs(lz) - inner[2]
        outside = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
        inside = np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0.0)
        return outside + inside - self.round


class Torus(Shape):
    """A ring of radius `major` and thickness `minor` around `centre`, its axis local z of `axes`."""

    def __init__(self, centre, major, minor, axes=None, squash=1.0):
        self.c = _vec(centre)
        self.major, self.minor = float(major), float(minor)
        self.squash = float(squash)  # < 1 flattens the ring's section along its axis
        self.axes = None if axes is None else _vec(axes)
        r = self.major + self.minor
        self.lo, self.hi = _box_bounds(self.c, self.axes, (r, r, self.minor))

    def field(self, X, Y, Z):
        lx, ly, lz = _local(X, Y, Z, self.c, self.axes)
        q = np.sqrt(lx * lx + ly * ly) - self.major
        return np.sqrt(q * q + (lz / self.squash) ** 2) - self.minor


class Loft(Shape):
    """A trunk whose horizontal sections are super-ellipses that change with height.

    `profile` rows are (z, half width, half depth to the front, half depth to the
    back, centre y); the front is -y. `power` 2 gives ellipses, more gives squarer
    sections. The ends are cut flat at the first and last z, rounded by `cap`.
    """

    def __init__(self, profile, power=2.0, cap=0.02):
        rows = np.array(sorted(profile), dtype=np.float64)
        self.profile = rows
        self.z, self.a, self.front, self.back, self.y0 = rows.T
        self.n = float(power)
        self.cap = float(cap)
        self.lo = np.array([-self.a.max(), self.y0.min() - self.front.max(), self.z[0]])
        self.hi = np.array([self.a.max(), self.y0.max() + self.back.max(), self.z[-1]])

    def field(self, X, Y, Z):
        a = np.interp(Z, self.z, self.a)
        f = np.interp(Z, self.z, self.front)
        b = np.interp(Z, self.z, self.back)
        dy = Y - np.interp(Z, self.z, self.y0)
        depth = np.where(dy < 0, f, b)
        n = self.n
        u, v = np.abs(X) / a, np.abs(dy) / depth
        k0 = (u ** n + v ** n) ** (1.0 / n)
        gx = u ** (n - 1) / a
        gy = v ** (n - 1) / depth
        grad = np.maximum(k0, 1e-6) ** (1 - n) * np.sqrt(gx * gx + gy * gy)
        side = np.where(grad > 1e-9, (k0 - 1.0) / np.maximum(grad, 1e-9), -np.minimum(a, depth))
        ends = np.maximum(self.z[0] - Z, Z - self.z[-1])
        return smax(side, ends, self.cap)


class Plane(Shape):
    """The half-space behind a plane through `point` with outward `normal`, within `lo`..`hi`."""

    def __init__(self, point, normal, lo, hi):
        self.p = _vec(point)
        n = _vec(normal)
        self.n = n / np.linalg.norm(n)
        self.lo, self.hi = _vec(lo), _vec(hi)

    def field(self, X, Y, Z):
        px, py, pz = _local(X, Y, Z, self.p, None)
        return px * self.n[0] + py * self.n[1] + pz * self.n[2]


# Composites ---------------------------------------------------------------------------

def _sub_block(x, y, z, bounds):
    lo, hi = bounds
    slices = []
    for axis, values in enumerate((x, y, z)):
        i0 = int(np.searchsorted(values, lo[axis], side='left'))
        i1 = int(np.searchsorted(values, hi[axis], side='right'))
        if i1 <= i0:
            return None
        slices.append(slice(i0, i1))
    return tuple(slices)


class Union(Shape):
    """The smooth union of `children`, blended over `k` metres."""

    def __init__(self, children, k=0.0):
        self.children = list(children)
        self.k = float(k)
        self.lo = np.min([c.bounds()[0] for c in self.children], axis=0) + MARGIN
        self.hi = np.max([c.bounds()[1] for c in self.children], axis=0) - MARGIN

    def grid(self, x, y, z):
        out = np.full((len(x), len(y), len(z)), FAR, dtype=np.float32)
        for child in self.children:
            block = _sub_block(x, y, z, child.bounds())
            if block is None:
                continue
            sx, sy, sz = block
            out[sx, sy, sz] = smin(out[sx, sy, sz], child.grid(x[sx], y[sy], z[sz]), self.k)
        return out

    def at(self, points):
        points = np.asarray(points, dtype=np.float64)
        out = np.full(len(points), FAR, dtype=np.float64)
        for child in self.children:
            near = _in_bounds(points, child.bounds())
            if near.any():
                out[near] = smin(out[near], child.at(points[near]), self.k)
        return out


class Cut(Shape):
    """`base` with `tool` carved away, blended over `k` metres."""

    def __init__(self, base, tool, k=0.0):
        self.base, self.tool, self.k = base, tool, float(k)
        self.lo, self.hi = base.lo, base.hi

    def grid(self, x, y, z):
        out = np.asarray(self.base.grid(x, y, z), dtype=np.float32)
        block = _sub_block(x, y, z, self.tool.bounds())
        if block is not None:
            sx, sy, sz = block
            out[sx, sy, sz] = smax(out[sx, sy, sz], -self.tool.grid(x[sx], y[sy], z[sz]), self.k)
        return out

    def at(self, points):
        out = np.array(self.base.at(points), dtype=np.float64)
        near = _in_bounds(points, self.tool.bounds())
        if near.any():
            out[near] = smax(out[near], -self.tool.at(points[near]), self.k)
        return out


class Within(Shape):
    """The part of `base` inside `mask`, blended over `k` metres."""

    def __init__(self, base, mask, k=0.0):
        self.base, self.mask, self.k = base, mask, float(k)
        self.lo = np.maximum(base.lo, mask.lo)
        self.hi = np.minimum(base.hi, mask.hi)

    def grid(self, x, y, z):
        out = np.asarray(self.base.grid(x, y, z), dtype=np.float32)
        result = np.full_like(out, FAR)
        block = _sub_block(x, y, z, self.mask.bounds())
        if block is not None:
            sx, sy, sz = block
            result[sx, sy, sz] = smax(out[sx, sy, sz], self.mask.grid(x[sx], y[sy], z[sz]), self.k)
        return result

    def at(self, points):
        out = np.full(len(points), FAR, dtype=np.float64)
        near = _in_bounds(points, self.mask.bounds())
        if near.any():
            out[near] = smax(self.base.at(points[near]), self.mask.at(points[near]), self.k)
        return out


class Shell(Shape):
    """`base` grown by `offset` metres (negative shrinks)."""

    def __init__(self, base, offset):
        self.base, self.offset = base, float(offset)
        self.lo, self.hi = base.lo - max(offset, 0), base.hi + max(offset, 0)

    def grid(self, x, y, z):
        return self.base.grid(x, y, z) - self.offset

    def at(self, points):
        return self.base.at(points) - self.offset


class Displace(Shape):
    """`base` with `fn(X, Y, Z)` (broadcast coordinates) added to its distance."""

    def __init__(self, base, fn, reach=0.0):
        self.base, self.fn, self.reach = base, fn, float(reach)
        self.lo, self.hi = base.lo - reach, base.hi + reach

    def grid(self, x, y, z):
        return self.base.grid(x, y, z) + self.fn(*_grid_axes(x, y, z))

    def at(self, points):
        points = np.asarray(points, dtype=np.float64)
        return self.base.at(points) + self.fn(points[:, 0], points[:, 1], points[:, 2])


class Layer(Shape):
    """A layer over `base` inside `region`, `thickness(X, Y, Z)` thick, thinning to `edge_min`
    over the last `edge` metres before the region's edge (a hairline, say)."""

    def __init__(self, base, region, thickness, edge, edge_min=0.0, reach=0.06):
        self.base, self.region, self.thickness = base, region, thickness
        self.edge, self.edge_min = float(edge), float(edge_min)
        self.lo = np.maximum(base.lo - reach, region.lo)
        self.hi = np.minimum(base.hi + reach, region.hi)

    def _layer(self, b, r, X, Y, Z):
        taper = np.clip(-r / self.edge, 0.0, 1.0)
        t = self.edge_min + (self.thickness(X, Y, Z) - self.edge_min) * taper
        return np.maximum(b - t, r)

    def grid(self, x, y, z):
        return self._layer(self.base.grid(x, y, z), self.region.grid(x, y, z), *_grid_axes(x, y, z))

    def at(self, points):
        points = np.asarray(points, dtype=np.float64)
        return self._layer(self.base.at(points), self.region.at(points), points[:, 0], points[:, 1], points[:, 2])


class Footprint(Shape):
    """A slab from `z0` to `z1` whose outline is `base`'s section at `z_at`, grown by `grow`."""

    def __init__(self, base, z_at, z0, z1, grow=0.0, round=0.0):
        self.base, self.z_at = base, float(z_at)
        self.z0, self.z1, self.grow, self.round = float(z0), float(z1), float(grow), float(round)
        self.lo = np.array([base.lo[0] - grow, base.lo[1] - grow, self.z0])
        self.hi = np.array([base.hi[0] + grow, base.hi[1] + grow, self.z1])

    def _slab(self, section, Z):
        return smax(section - self.grow, np.maximum(self.z0 - Z, Z - self.z1), self.round)

    def grid(self, x, y, z):
        section = self.base.grid(x, y, np.array([self.z_at]))
        return self._slab(section, z[None, None, :])

    def at(self, points):
        points = np.asarray(points, dtype=np.float64)
        flat = points.copy()
        flat[:, 2] = self.z_at
        return self._slab(self.base.at(flat), points[:, 2])


# Mirroring ----------------------------------------------------------------------------

def _flip(v):
    v = np.array(v, dtype=np.float64)
    v[..., 0] = -v[..., 0]
    return v


def _flip_axes(axes):
    if axes is None:
        return None
    axes = np.array(axes, dtype=np.float64)
    axes[:, 0] = -axes[:, 0]
    return axes


def _flip_bounds(shape, out):
    out.lo, out.hi = _flip(shape.hi), _flip(shape.lo)
    out.lo[1:], out.hi[1:] = shape.lo[1:], shape.hi[1:]
    return out


def mirror(shape):
    """`shape` reflected across x = 0: a left limb becomes the right one."""
    if isinstance(shape, Cone):
        return Cone(_flip(shape.a), _flip(shape.b), shape.ra, shape.rb)
    if isinstance(shape, Ellipsoid):
        return Ellipsoid(_flip(shape.c), shape.r, _flip_axes(shape.axes))
    if isinstance(shape, Box):
        return Box(_flip(shape.c), shape.half, _flip_axes(shape.axes), shape.round)
    if isinstance(shape, Torus):
        return Torus(_flip(shape.c), shape.major, shape.minor, _flip_axes(shape.axes), shape.squash)
    if isinstance(shape, Plane):
        return _flip_bounds(shape, Plane(_flip(shape.p), _flip(shape.n), shape.lo, shape.hi))
    if isinstance(shape, Loft):
        return shape
    if isinstance(shape, Union):
        return Union([mirror(c) for c in shape.children], shape.k)
    if isinstance(shape, Cut):
        return Cut(mirror(shape.base), mirror(shape.tool), shape.k)
    if isinstance(shape, Within):
        return Within(mirror(shape.base), mirror(shape.mask), shape.k)
    if isinstance(shape, Shell):
        return Shell(mirror(shape.base), shape.offset)
    if isinstance(shape, Footprint):
        return Footprint(mirror(shape.base), shape.z_at, shape.z0, shape.z1, shape.grow, shape.round)
    if isinstance(shape, Displace):
        fn = shape.fn
        return _flip_bounds(shape, Displace(mirror(shape.base), lambda X, Y, Z: fn(-X, Y, Z), shape.reach))
    raise TypeError(f"cannot mirror {type(shape).__name__}")


# Surface nets -------------------------------------------------------------------------

_CORNERS = np.array([[i, j, k] for k in (0, 1) for j in (0, 1) for i in (0, 1)])
_EDGES = [(a, b) for a in range(8) for b in range(8)
          if a < b and np.abs(_CORNERS[a] - _CORNERS[b]).sum() == 1]


def sample(shape, step, lo=None, hi=None):
    """The field of `shape` on a grid of spacing `step`, with the grid's origin and step.

    The grid is symmetric about x = 0, so a symmetric shape meshes symmetrically.
    """
    lo = shape.lo - 2 * step if lo is None else _vec(lo)
    hi = shape.hi + 2 * step if hi is None else _vec(hi)
    half_x = max(abs(lo[0]), abs(hi[0]))
    nx = int(np.ceil(half_x / step))
    xs = (np.arange(-nx, nx + 1) * step).astype(np.float64)
    ys = np.arange(np.floor(lo[1] / step), np.ceil(hi[1] / step) + 1) * step
    zs = np.arange(np.floor(lo[2] / step), np.ceil(hi[2] / step) + 1) * step
    field = np.full((len(xs), len(ys), len(zs)), FAR, dtype=np.float32)
    # Evaluate in slabs along z to keep memory to a few hundred MB.
    slab = max(1, int(4_000_000 // (len(xs) * len(ys))))
    for k0 in range(0, len(zs), slab):
        k1 = min(len(zs), k0 + slab)
        field[:, :, k0:k1] = shape.grid(xs, ys, zs[k0:k1])
    return field, np.array([xs[0], ys[0], zs[0]]), step


def surface_nets(field, origin, step):
    """Vertices and quads of the zero surface of a sampled field, quads facing outwards."""
    inside = field < 0
    nx, ny, nz = field.shape
    # A cell (named by its lowest corner) gets a vertex when its corners disagree.
    any_in = np.zeros((nx - 1, ny - 1, nz - 1), dtype=bool)
    all_in = np.ones((nx - 1, ny - 1, nz - 1), dtype=bool)
    for c in _CORNERS:
        corner = inside[c[0]:nx - 1 + c[0], c[1]:ny - 1 + c[1], c[2]:nz - 1 + c[2]]
        any_in |= corner
        all_in &= corner
    mixed = any_in & ~all_in
    cells = np.argwhere(mixed)
    index = np.full(mixed.shape, -1, dtype=np.int64)
    index[mixed] = np.arange(len(cells))
    # Each vertex sits at the mean of the crossings on its cell's edges.
    total = np.zeros((len(cells), 3))
    count = np.zeros(len(cells))
    ci, cj, ck = cells[:, 0], cells[:, 1], cells[:, 2]
    for a, b in _EDGES:
        ca, cb = _CORNERS[a], _CORNERS[b]
        va = field[ci + ca[0], cj + ca[1], ck + ca[2]].astype(np.float64)
        vb = field[ci + cb[0], cj + cb[1], ck + cb[2]].astype(np.float64)
        crossing = (va < 0) != (vb < 0)
        t = np.where(crossing, va / np.where(crossing, va - vb, 1.0), 0.0)
        point = ca[None, :] + t[:, None] * (cb - ca)[None, :]
        total[crossing] += point[crossing]
        count[crossing] += 1
    verts = origin + (cells + total / count[:, None]) * step
    # Each grid edge that crosses the surface joins the four cells around it.
    quads = []
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        lo_slice = [slice(None)] * 3
        hi_slice = [slice(None)] * 3
        lo_slice[axis] = slice(0, -1)
        hi_slice[axis] = slice(1, None)
        a_in = inside[tuple(lo_slice)]
        b_in = inside[tuple(hi_slice)]
        crossing = a_in != b_in
        # The four cells need valid indices: the edge must not lie on the grid's border.
        for border in (u, v):
            s = [slice(None)] * 3
            s[border] = 0
            crossing[tuple(s)] = False
            s[border] = -1
            crossing[tuple(s)] = False
        edges = np.argwhere(crossing)
        if not len(edges):
            continue
        outward = a_in[crossing]  # inside at the low end: the surface faces +axis
        ring = []
        for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1)):
            c = edges.copy()
            c[:, u] -= 1 - du
            c[:, v] -= 1 - dv
            ring.append(index[c[:, 0], c[:, 1], c[:, 2]])
        ring = np.stack(ring, axis=1)
        ring[~outward] = ring[~outward][:, ::-1]
        quads.append(ring)
    quads = np.concatenate(quads) if quads else np.zeros((0, 4), dtype=np.int64)
    return verts, quads


def mesh_field(shape, step, lo=None, hi=None):
    """Sample `shape` and mesh its surface: (vertices, quads)."""
    field, origin, step = sample(shape, step, lo, hi)
    return surface_nets(field, origin, step)
