// if not defined, declare the compiler object as part of plt
if(typeof(plt) === "undefined")          plt = {};
if(typeof(plt.compiler) === "undefined") plt.compiler = {};

/*
 TODO
 - desugar Symbols
 - fix and uncomment uses of 'tagApplicationOperator_Module'
 - test cases get desugared into native calls (and thunks?)
 - how to add struct binding when define-struct is desugared away?
*/

(function () {
 'use strict';
 
 // tag-application-operator/module: Stx module-name -> Stx
 // Adjust the lexical context of the func so it refers to the environment of a particular module.
 function tagApplicationOperator_Module(call_exp, moduleName){
    var func = call_exp.func,
        operands = call_exp.args,
        module = defaultModuleResolver(moduleName),
        env = new plt.compiler.emptyEnv().extendEnv_moduleBinding(module);
    call_exp.context = env;
    return call_exp;
 }

// forceBooleanContext: stx, loc, bool -> stx
// Force a boolean runtime test on the given expression.
 function forceBooleanContext(stx, loc, boolExpr){
    stx = '"'+stx+'"'; // add quotes to the stx
    var runtimeCall = new callExpr(new symbolExpr("verify-boolean-branch-value")
                                   , [new quotedExpr(new symbolExpr(stx))
                                      , new quotedExpr(loc.toVector())
                                      , boolExpr
                                      , new quotedExpr(boolExpr.location.toVector())]);
    runtimeCall.location = boolExpr.location;
//    tagApplicationOperator_Module(runtimeCall, 'moby/runtime/kernel/misc');
    return runtimeCall;
 }
 
 //////////////////////////////////////////////////////////////////////////////
 // DESUGARING ////////////////////////////////////////////////////////////////

 // desugarProgram : Listof Programs null/pinfo -> [Listof Programs, pinfo]
 // desugar each program, appending those that desugar to multiple programs
 function desugarProgram(programs, pinfo, isTopLevelExpr){
      var acc = [ [], (pinfo || new plt.compiler.pinfo())];
      return programs.reduce((function(acc, p){
            var desugaredAndPinfo = p.desugar(acc[1]);
            // if it's an expression, insert a print-values call so it shows up in the repl
            if(plt.compiler.isExpression(p) && isTopLevelExpr){
              var runtimeCall = new callExpr(new symbolExpr("print-values"), [desugaredAndPinfo[0]]);
              runtimeCall.location = p.location;
              desugaredAndPinfo[0] = runtimeCall;
//              tagApplicationOperator_Module(runtimeCall,'moby/runtime/kernel/misc');
            }
            if(desugaredAndPinfo[0].length){
              acc[0] = acc[0].concat(desugaredAndPinfo[0]);
            } else {
              acc[0].push(desugaredAndPinfo[0]);
            }
            return [acc[0], desugaredAndPinfo[1]];
        }), acc);
 }
 
 // Program.prototype.desugar: pinfo -> [Program, pinfo]
 Program.prototype.desugar = function(pinfo){ return [this, pinfo]; };
 defFunc.prototype.desugar = function(pinfo){
    // check for duplicate arguments
    checkDuplicateIdentifiers([this.name].concat(this.args), this.stx[0], this.location);
    // check for non-symbol arguments
    this.args.forEach(function(arg){
       if(!(arg instanceof symbolExpr)){
        throwError(new types.Message([new types.ColoredPart(this.stx.val, this.stx.location)
                                , ": expected a variable but found "
                                , new types.ColoredPart("something else", arg.location)])
                   , sexp.location);
      }
    });
    var bodyAndPinfo = this.body.desugar(pinfo);
    this.body = bodyAndPinfo[0];
    return [this, bodyAndPinfo[1]];
 };
 defVar.prototype.desugar = function(pinfo){
    var exprAndPinfo = this.expr.desugar(pinfo);
    this.expr = exprAndPinfo[0];
    return [this, exprAndPinfo[1]];
 };
 defVars.prototype.desugar = function(pinfo){
    var exprAndPinfo = this.expr.desugar(pinfo);
    this.expr = exprAndPinfo[0];
    return [this, exprAndPinfo[1]];
 };
 defStruct.prototype.desugar = function(pinfo){
    var name = this.name.toString(),
        fields = this.fields.map(function(f){return f.toString();}),
        mutatorIds = fields.map(function(field){return name+'-'+field+'-set!';}),
        ids = [name, 'make-'+name, name+'?', name+'-ref', , name+'-set!'], //.concat(mutatorIds),
        idSymbols = ids.map(function(id){return new symbolExpr(id);}),
        call = new callExpr(new primop(new symbolExpr('make-struct-type')),
                            [new quotedExpr(new symbolExpr(name)),
                             new symbolExpr("#f"),
                             new numberExpr(fields.length),
                             new numberExpr(0)]);
        call.location = this.location;
    var defineValuesStx = [new defVars(idSymbols, call)],
        selectorStx = [];
    // given a field, make a definition that binds struct-field to the result of
    // a make-struct-field accessor call in the runtime
    function makeAccessorDefn(f, i){
      var runtimeOp = new primop(new symbolExpr('make-struct-field-accessor')),
          runtimeArgs = [new symbolExpr(name+'-ref'), new numberExpr(i), new quotedExpr(new symbolExpr(f))],
          runtimeCall = new callExpr(runtimeOp, runtimeArgs),
          defineVar = new defVar(new symbolExpr(name+'-'+f), runtimeCall);
      selectorStx.push(defineVar);
    }
    fields.forEach(makeAccessorDefn);
    return [defineValuesStx.concat(selectorStx), pinfo];
 };
 beginExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram(this.exprs, pinfo);
    this.exprs = exprsAndPinfo[0];
    return [this, exprsAndPinfo[1]];
 };
 lambdaExpr.prototype.desugar = function(pinfo){
    // if this was parsed from raw syntax, check for duplicate arguments
    if(this.stx) checkDuplicateIdentifiers(this.args, this.stx[0], this.location);
    var bodyAndPinfo = this.body.desugar(pinfo);
    this.body = bodyAndPinfo[0];
    return [this, bodyAndPinfo[1]];
 };
 localExpr.prototype.desugar = function(pinfo){
    var defnsAndPinfo = desugarProgram(this.defs, pinfo);
    var exprAndPinfo = this.body.desugar(defnsAndPinfo[1]);
    this.defs = defnsAndPinfo[0];
    this.body = exprAndPinfo[0];
    return [this, exprAndPinfo[1]];
 };
 callExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram([this.func].concat(this.args), pinfo);
    this.func = exprsAndPinfo[0][0];
    this.args = exprsAndPinfo[0].slice(1);
    return [this, exprsAndPinfo[1]];
 };
 ifExpr.prototype.desugar = function(pinfo){
    var exprsAndPinfo = desugarProgram([this.predicate,
                                        this.consequence,
                                        this.alternative],
                                       pinfo);
    // preserve location information -- esp for the predicate!
    exprsAndPinfo[0][0].location = this.predicate.location;
    exprsAndPinfo[0][1].location = this.consequence.location;
    exprsAndPinfo[0][2].location = this.alternative.location;
    this.predicate = forceBooleanContext(this.stx, this.stx.location, exprsAndPinfo[0][0]);
    this.consequence = exprsAndPinfo[0][1];
    this.alternative = exprsAndPinfo[0][2];
    return [this, exprsAndPinfo[1]];
 };

 // letrecs become locals
 letrecExpr.prototype.desugar = function(pinfo){
    function bindingToDefn(b){
      var def = new defVar(b.first, b.second);
      def.location = b.location;
      return def};
    var localAndPinfo = new localExpr(this.bindings.map(bindingToDefn), this.body).desugar(pinfo);
    localAndPinfo[0].location = this.location;
    return localAndPinfo;
 };
 // lets become calls
 letExpr.prototype.desugar = function(pinfo){
    var ids   = this.bindings.map(coupleFirst),
        exprs = this.bindings.map(coupleSecond);
    return new callExpr(new lambdaExpr(ids, this.body), exprs).desugar(pinfo);
 };
 // let*s become nested lets
 letStarExpr.prototype.desugar = function(pinfo){
    var body = this.body;
    for(var i=0; i<this.bindings.length; i++){
      body = new letExpr([this.bindings[i]], body);
    }
    return body.desugar(pinfo);
 };
 // conds become nested ifs
 condExpr.prototype.desugar = function(pinfo){
    // base case is all-false
    var expr = new callExpr(new symbolExpr("throw-cond-exhausted-error")
                            , [new quotedExpr(this.location.toVector())]);
    for(var i=this.clauses.length-1; i>-1; i--){
      expr = new ifExpr(this.clauses[i].first, this.clauses[i].second, expr, this.stx);
      expr.location = this.location;
    }
    return expr.desugar(pinfo);
 };
 // case become nested ifs, with ormap as the predicate
 caseExpr.prototype.desugar = function(pinfo){
    var that = this,
        caseStx = new symbolExpr("if"); // The server returns "if" here, but I am almost certain it's a bug
    caseStx.location = this.location;

    var pinfoAndValSym = pinfo.gensym('val'),      // create a symbol 'val'
        updatedPinfo1 = pinfoAndValSym[0],        // generate pinfo containing 'val'
        valStx = pinfoAndValSym[1];               // remember the symbolExpr for 'val'
    var pinfoAndXSym = updatedPinfo1.gensym('x'), // create another symbol 'x' using pinfo1
        updatedPinfo2 = pinfoAndXSym[0],          // generate pinfo containing 'x'
        xStx = pinfoAndXSym[1];                   // remember the symbolExpr for 'x'

    // if there's an 'else', pop off the clause and use the result as the base
    var expr, clauses = this.clauses, lastClause = clauses[this.clauses.length-1];
    if((lastClause.first instanceof symbolExpr) && (lastClause.first.val === 'else')){
      expr = lastClause.second;
      clauses.pop();
    } else {
      expr = new callExpr(new symbolExpr('void'),[]);
    }
 
    // This is predicate we'll be applying using ormap: (lambda (x) (equal? x val))
    var predicateStx = new lambdaExpr([xStx], new callExpr(new symbolExpr('equal?'),
                                                          [xStx, valStx]));
    var stxs = [valStx, xStx, predicateStx]; // track all the syntax we've created
    // generate (if (ormap <predicate> (quote clause.first)) clause.second base)
    function processClause(base, clause){
      var ormapStx = new primop('ormap'),
          quoteStx = new quotedExpr(clause.first),
          callStx = new callExpr(ormapStx, [predicateStx, quoteStx]),
          ifStx = new ifExpr(callStx, clause.second, base, caseStx);
      stxs = stxs.concat([ormapStx, callStx, quoteStx, ifStx]);
      return ifStx;
    }

    // build the body of the let by decomposing cases into nested ifs
    var binding = new couple(valStx, this.expr),
        body = clauses.reduceRight(processClause, expr),
        letExp = new letExpr([binding], body);
    stxs = stxs.concat([binding, body, letExp]);

    // assign location to every stx element
    var loc = this.location;
    stxs.forEach(function(stx){stx.location = loc;});
    return letExp.desugar(updatedPinfo2);
 };
 // ands become nested ifs
 andExpr.prototype.desugar = function(pinfo){
    var expr = this.exprs[this.exprs.length-1];
    for(var i= this.exprs.length-2; i>-1; i--){ // ASSUME length >=2!!!
      expr = new ifExpr(this.exprs[i], expr, new symbolExpr("false"), this.stx);
      expr.location = this.location;
    }
    return expr.desugar(pinfo);
 };
 // ors become nested lets-with-if-bodies
 orExpr.prototype.desugar = function(pinfo){
    // grab the last expr, and remove it from the list and desugar
    var expr = forceBooleanContext(this.stx, this.stx.location, this.exprs.pop()),
        that = this;
 
    // given a desugared chain, add this expr to the chain
    // we optimize the predicate/consequence by binding the expression to a temp symbol
    function convertToNestedIf(restAndPinfo, expr){
      var pinfoAndTempSym = pinfo.gensym('tmp'),
          exprLoc = expr.location,
          tmpSym = pinfoAndTempSym[1],
          orSym = new symbolExpr("or"),
          expr = forceBooleanContext("or", that.stx.location, expr), // force a boolean context on the value
          tmpBinding = new couple(tmpSym, expr);           // (let (tmpBinding) (if tmpSym tmpSym (...))
      tmpSym.location = that.location;
      tmpBinding.location = exprLoc;
      var if_exp = new ifExpr(tmpSym, tmpSym, restAndPinfo[0], new symbolExpr("if")),
          let_exp = new letExpr([tmpBinding], if_exp);
      if_exp.stx.location = that.location;
      if_exp.location = exprLoc;
      let_exp.location = exprLoc;
      return [let_exp, restAndPinfo[1]];
    }
    var exprsAndPinfo = this.exprs.reduceRight(convertToNestedIf, [expr, pinfo]);
    var desugared = exprsAndPinfo[0].desugar(exprsAndPinfo[1]);
    return [desugared[0], exprsAndPinfo[1]];
 };
 
 quotedExpr.prototype.desugar = function(pinfo){
    function desugarQuotedItem(sexp){
      if(sexp instanceof Array) return new callExpr(new primop('list'), sexp.map(desugarQuotedItem));
      if(sexp instanceof symbolExpr) return new quotedExpr(sexp.val);
      else return sexp;
    }
    if(this.val instanceof Array){
      var call_exp = new callExpr(new primop('list'), this.val.map(desugarQuotedItem));
      call_exp.location = this.location;
      return [call_exp, pinfo];
    } else {
      return [this, pinfo];
    }
 };

 // go through each item in search of unquote or unquoteSplice
 quasiquotedExpr.prototype.desugar = function(pinfo){
    function desugarQuasiQuotedElements(element) {
      if(element instanceof unquoteSplice){
        return element.val.desugar(pinfo)[0];
      } else if(element instanceof unquotedExpr){
        return new callExpr(new primop(new symbolExpr('list')), [element.val.desugar(pinfo)[0]]);
      } else if(element instanceof quasiquotedExpr){
        /* we first must exit the regime of quasiquote by calling desugar on the
         * list a la unquote or unquoteSplice */
        throwError("ASSERT: we should never parse a quasiQuotedExpr within an existing quasiQuotedExpr")
      } else if(element instanceof Array){
        return new callExpr(new primop(new symbolExpr('list')),
                            [new callExpr(new primop(new symbolExpr('append')),
                                          element.map(desugarQuasiQuotedElements))]);
      } else {
        return new callExpr(new primop(new symbolExpr('list')),
                            [new quotedExpr(element.toString())]);
      }
    }

    if(this.val instanceof Array){
      var result = new callExpr(new primop(new symbolExpr('append')),
                                this.val.map(desugarQuasiQuotedElements));
      return [result, pinfo];
    } else {
      return [new quotedExpr(this.val.toString()), pinfo];
    }
 };
 symbolExpr.prototype.desugar = function(pinfo){
    // if we're not in a clause, we'd better not see an "else"...
    if(!this.isClause && (this.val === "else")){
        var loc = (this.parent && this.parent[0] === this)? this.parent.location : this.location;
        throwError(new types.Message([new types.ColoredPart(this.val, loc)
                                      , ": not allowed "
                                      , new types.ColoredPart("here", loc)
                                      , ", because this is not a question in a clause"]),
                   loc);
    }
    // if this is a keyword without a parent, or if it's not the first child of the parent
    if(!this.parent &&
       (plt.compiler.keywords.indexOf(this.val) > -1) && (this.val !== "else")){
        throwError(new types.Message([new types.ColoredPart(this.val, this.location)
                                      , ": expected an open parenthesis before "
                                      , this.val
                                      , ", but found none"]),
                    this.location);
    }
    // desugar 'true' and 'false' to #t and #f
    if(this.val === 'true') this.val = '#t';
    if(this.val === 'false') this.val = '#f';
    return [this, pinfo];
 };
 
 unsupportedExpr.prototype.desugar = function(pinfo){
    this.location.span = this.errorSpan;
    throwError(this.errorMsg, this.location, "Error-GenericReadError");
 }
 
 //////////////////////////////////////////////////////////////////////////////
 // COLLECT DEFINITIONS ///////////////////////////////////////////////////////

 // extend the Program class to collect definitions
 // Program.collectDefnitions: pinfo -> pinfo
 Program.prototype.collectDefinitions = function(pinfo){ return pinfo; };

 // bf: symbol path number boolean string -> binding:function
 // Helper function.
 function bf(name, modulePath, arity, vararity, loc){
    return new bindingFunction(name, modulePath, arity, vararity, [], false, loc);
 }
 defFunc.prototype.collectDefinitions = function(pinfo){
    var binding = bf(this.name.val, false, this.args.length, false, this.name.location);
    return pinfo.accumulateDefinedBinding(binding, this.location);
 };
 defVar.prototype.collectDefinitions = function(pinfo){
    var binding = (this.expr instanceof lambdaExpr)?
                    bf(this.name.val, false, this.expr.args.length, false, this.name.location)
                  : new bindingConstant(this.name.val, false, [], this.name.location);
    return pinfo.accumulateDefinedBinding(binding, this.location);
 };
 defVars.prototype.collectDefinitions = function(pinfo){
    var that = this;
    return this.names.reduce(function(pinfo, id){
      var binding = new bindingConstant(id.val, false, [], id.location);
      return pinfo.accumulateDefinedBinding(binding, that.location);
    }, pinfo);
 };

 // When we hit a require, we have to extend our environment to include the list of module
 // bindings provided by that module.
 requireExpr.prototype.collectDefinitions = function(pinfo){
    var errorMessage =  ["require", ": ", "moby-error-type:Unknown-Module: ", this.spec],
        moduleName = pinfo.modulePathResolver(this.spec.val, this.currentModulePath);
 
    // if it's an invalid moduleName, throw an error
    if(!moduleName){
      throwError(new types.Message(["Found require of the module "
                                    , this.spec
                                    , ", but this module is unknown."])
                 , this.spec.location
                 ,"Error-UnknownModule");
    }

/*    var moduleBinding = pinfo.moduleResolver(moduleName);
    // if it's an invalid moduleBinding, throw an error
    if(!moduleBinding){
      throwError(errorMessage, this.location);
    }
 
    // if everything is okay, add the module bindings to this pinfo and return
    pinfo.accumulateModule(pinfo.accumulateModuleBindings(moduleBinding.bindings));
 */
    return pinfo;
 };
 localExpr.prototype.collectDefinitions = function(pinfo){
    // remember previously defined names, so we can revert to them later
    // in the meantime, scan the body
    var prevKeys = pinfo.definedNames.keys(),
        localPinfo= this.defs.reduce(function(pinfo, p){
                                        return p.collectDefinitions(pinfo);
                                        }
                                        , pinfo),
        newPinfo  = this.body.collectDefinitions(localPinfo),
        newKeys = newPinfo.definedNames.keys();
    // now that the body is scanned, forget all the new definitions
    newKeys.forEach(function(k){
                  if(prevKeys.indexOf(k) === -1) newPinfo.definedNames.remove(k);
                });
    return newPinfo;
 };
 
 // BINDING STRUCTS ///////////////////////////////////////////////////////
 function provideBindingId(symbl){ this.symbl = symbl;}
 function provideBindingStructId(symbl){ this.symbl = symbl; }

 //////////////////////////////////////////////////////////////////////////////
 // COLLECT PROVIDES //////////////////////////////////////////////////////////

 // extend the Program class to collect provides
 // Program.collectProvides: pinfo -> pinfo
 Program.prototype.collectProvides = function(pinfo){
    return pinfo;
 };
 provideStatement.prototype.collectProvides = function(pinfo){
    var that = this;
    // collectProvidesFromClause : pinfo clause -> pinfo
    function collectProvidesFromClause(pinfo, clause){
      // if it's a symbol, make sure it's defined (otherwise error)
      if (clause instanceof symbolExpr){
        if(pinfo.definedNames.containsKey(clause.val)){
          pinfo.providedNames.put(clause.val, new provideBindingId(clause));
          return pinfo;
        } else {
          throwError(new types.Message(["The name '"
                                        , new types.ColoredPart(clause.toString(), clause.location)
                                        , "', is not defined in the program, and cannot be provided."])
                     , clause.location);
        }
      // if it's an array, make sure the struct is defined (otherwise error)
      // NOTE: ONLY (struct-out id) IS SUPPORTED AT THIS TIME
      } else if(clause instanceof Array){
          if(pinfo.definedNames.containsKey(clause[1].val) &&
             (pinfo.definedNames.get(clause[1].val) instanceof bindingStructure)){
              // add the entire bindingStructure to the provided binding, so we
              // can access fieldnames, predicates, and permissions later
              var b = new provideBindingStructId(clause[1], pinfo.definedNames.get(clause[1].val));
              pinfo.providedNames.put(clause.val, b);
              return pinfo;
          } else {
            throwError(new types.Message(["The name '"
                                          , new types.ColoredPart(clause[1].toString(), clause[1].location)
                                          , "', is not defined in the program, and cannot be provided"])
                       , clause.location);
          }
      // anything with a different format throws an error
      } else {
        throw "Impossible: all invalid provide clauses should have been filtered out!";
      }
    }
    return this.clauses.reduce(collectProvidesFromClause, pinfo);
  };
 
 //////////////////////////////////////////////////////////////////////////////
 // ANALYZE USES //////////////////////////////////////////////////////////////

 // extend the Program class to analyzing uses
 // Program.analyzeUses: pinfo -> pinfo
 Program.prototype.analyzeUses = function(pinfo, env){ return pinfo; };
 defVar.prototype.analyzeUses = function(pinfo, env){
    // if it's a lambda, extend the environment with the function, then analyze as a lambda
    if(this.expr instanceof lambdaExpr) pinfo.env.extend(bf(this.name.val, false, this.expr.args.length, false, this.location));
    return this.expr.analyzeUses(pinfo, pinfo.env);
 };
 defVars.prototype.analyzeUses = function(pinfo, env){
    return this.expr.analyzeUses(pinfo, pinfo.env);
 };
 defFunc.prototype.analyzeUses = function(pinfo, env){
    return this.body.analyzeUses(pinfo, pinfo.env);
 };
 beginExpr.prototype.analyzeUses = function(pinfo, env){
    return this.exprs.reduce(function(p, expr){return expr.analyzeUses(p, env);}, pinfo);
 };
 lambdaExpr.prototype.analyzeUses = function(pinfo, env){
    var env1 = pinfo.env,
        env2 = this.args.reduce(function(env, arg){
          return env.extend(new bindingConstant(arg.val, false, [], arg.location));
        }, env1);
    return this.body.analyzeUses(pinfo, env2);
 };
 localExpr.prototype.analyzeUses = function(pinfo, env){
    // remember previously used bindings, so we can revert to them later
    // in the meantime, scan the body
    var prevKeys = pinfo.usedBindingsHash.keys(),
        localPinfo= this.defs.reduce(function(pinfo, p){
                                        return p.analyzeUses(pinfo, env);
                                        }
                                        , pinfo),
        newPinfo  = this.body.analyzeUses(localPinfo, env),
        newKeys = newPinfo.usedBindingsHash.keys();
    // now that the body is scanned, forget all the new definitions
    newKeys.forEach(function(k){
                  if(prevKeys.indexOf(k) === -1) newPinfo.usedBindingsHash.remove(k);
                });
    return newPinfo;
 };
 callExpr.prototype.analyzeUses = function(pinfo, env){
    return [this.func].concat(this.args).reduce(function(p, arg){
                            return (arg instanceof Array)?
                                    // if arg is an array, reduce THAT
                                    arg.reduce((function(pinfo, p){return p.analyzeUses(pinfo, pinfo.env);})
                                               , pinfo)
                                    // otherwise analyze and return
                                    : arg.analyzeUses(p, env);
                            }, pinfo);
 }
 ifExpr.prototype.analyzeUses = function(pinfo, env){
    var exps = [this.predicate, this.consequence, this.alternative];
    return exps.reduce(function(p, exp){
                            return exp.analyzeUses(p,env);
                            }, pinfo);
 };
 symbolExpr.prototype.analyzeUses = function(pinfo, env){
    // if this is a keyword without a parent, or if it's not the first child of the parent
    if((plt.compiler.keywords.indexOf(this.val) > -1) &&
       (!this.parent || this.parent[0]!== this)){
        throwError(new types.Message([new types.ColoredPart(this.val, this.location)
                                      , ": expected an open parenthesis before "
                                      , this.val
                                      , ", but found none"]),
                    this.location);
    }
   if(env.lookup_context(this.val)){
      return pinfo.accumulateBindingUse(env.lookup_context(this.val), pinfo);
    } else {
      return pinfo.accumulateFreeVariableUse(this.val, pinfo);
    }
 };


/////////////////////////////////////////////////////////////
 function analyze(programs){
    return programAnalyzeWithPinfo(programs, plt.compiler.getBasePinfo("base"));
 }
 
 // programAnalyzerWithPinfo : [listof Programs], pinfo -> pinfo
 // build up pinfo by looking at definitions, provides and uses
 function programAnalyzeWithPinfo(programs, pinfo){
   // collectDefinitions: [listof Programs] pinfo -> pinfo
   // Collects the definitions either imported or defined by this program.
   function collectDefinitions(programs, pinfo){
     // FIXME: this does not yet say anything if a definition is introduced twice
     // in the same lexical scope.  We must do this error check!
     return programs.reduce((function(pinfo, p){
                             return p.collectDefinitions(pinfo);
                             })
                            , pinfo);
   }
   // collectProvides: [listof Programs] pinfo -> pinfo
   // Walk through the program and collect all the provide statements.
   function collectProvides(programs, pinfo){
      return programs.reduce((function(pinfo, p){
                                return p.collectProvides(pinfo)
                              })
                             , pinfo);
   }
   // analyzeUses: [listof Programs] pinfo -> pinfo
   // Collects the uses of bindings that this program uses.
    function analyzeUses(programs, pinfo){
      return programs.reduce((function(pinfo, p){
                                return p.analyzeUses(pinfo, pinfo.env);
                              })
                             , pinfo);
    }
    var pinfo1 = collectDefinitions(programs, pinfo);
    var pinfo2 = collectProvides(programs, pinfo1);
    return analyzeUses(programs, pinfo2);
 }
 
 /////////////////////
 /* Export Bindings */
 /////////////////////
 plt.compiler.desugar = function(p, pinfo){return desugarProgram(p, pinfo, true)};
 plt.compiler.analyze = analyze;
})();