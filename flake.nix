{
  description = "Speckl — behavioral specification compiler";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.buildNpmPackage {
          pname = "speckl";
          version = "0.3.1";

          src = pkgs.lib.cleanSource ./compiler;

          npmDepsHash = "sha256-UN5SeJEgDaXzY+Jr2rmjQc/MjILZoWGqs2BWkQ8rnac="; # will be computed on first build

          buildPhase = ''
            npm run build --silent
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/speckl
            cp -r dist/* $out/lib/speckl/
            cp -r node_modules $out/lib/speckl/node_modules

            printf '#!/bin/sh\nexec %s/bin/node %s/lib/speckl/index.js "$@"\n' "${pkgs.nodejs}" "$out" > $out/bin/speckl
            chmod +x $out/bin/speckl
          '';

          meta = with pkgs.lib; {
            description = "Behavioral specification compiler";
            license = licenses.mit;
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs ];
        };
      });
}
